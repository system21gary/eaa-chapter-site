import config from '../config.js';
import { TZ } from './localtime.js';
import path from 'node:path';
import { renderEmail, para, button, detailRow, esc, link as emailLink, quote, linkFallback, plainFooter, LOGO_CID } from './email-layout.js';
import { run, all, get, nowIso } from '../db/index.js';

/**
 * Outbound mail.
 *
 * Every message is written to `email_outbox` first and delivered afterwards,
 * by a background worker, never inside the request that asked for it. Two
 * reasons, both learned the hard way by other people:
 *
 *   - A relay hiccup must not fail an action that already succeeded. The
 *     membership request is saved, the borrow request is recorded; if the
 *     notification cannot go out this second, that is a delivery problem, not
 *     the member's problem, and it should not greet them with an error page.
 *   - /forgot answers identically for a registered address and an unknown one
 *     on purpose. Sending in-request breaks that: only the known address
 *     attempts delivery, so only it can fail, and the difference tells an
 *     attacker which addresses have accounts.
 *
 * With MAIL_TRANSPORT=outbox (the default) nothing is delivered at all and the
 * queue is the product: an admin reads invitation and reset links out of it
 * during setup, which is how the site bootstraps without ever emailing a
 * password. Set MAIL_TRANSPORT=smtp plus the SMTP_* variables to go live; no
 * call site changes.
 */

/**
 * How long to wait after each failed attempt.
 *
 * One entry per gap, so a message gets BACKOFF_MINUTES.length + 1 attempts --
 * six, spread over about five and a half hours. That is long enough to ride out
 * a relay outage or a rate limit, and short enough that a genuinely broken
 * setting surfaces as a failure the same morning rather than retrying quietly
 * for a week.
 */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

const isLive = () => config.mail.transport === 'smtp';

/** True for addresses at a domain that cannot receive mail by definition. */
function isSuppressed(address) {
  const domain = String(address).split('@').pop()?.trim().toLowerCase() ?? '';
  return config.mail.suppressDomains.has(domain);
}

export async function sendMail({ to, subject, text, html = null, replyTo = null, cc = [], headers = null }) {
  const now = nowIso();
  // Copies go in the Cc header (so a reply-all reaches them too). Never the To address twice.
  const ccList = [...new Set([].concat(cc ?? []).map((a) => String(a).trim()).filter(Boolean))].filter(
    (a) => a.toLowerCase() !== String(to).toLowerCase()
  );
  const info = run(
    `INSERT INTO email_outbox
       (to_addr, subject, body_text, body_html, reply_to, cc, headers, created_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // next_attempt_at NULL when there is no transport: the row is a record,
    // not a pending delivery, so turning SMTP on later does not flush it.
    [to, subject, text, html, replyTo, ccList.join(', ') || null, headers ? JSON.stringify(headers) : null, now, isLive() ? now : null]
  );
  const id = Number(info.lastInsertRowid);

  if (!isLive()) {
    if (config.isDev) {
      console.log(
        `\n──────── outbox #${id} ────────\nTo:      ${to}${ccList.length ? `\nCc:      ${ccList.join(', ')}` : ''}\nSubject: ${subject}\n\n${text}\n────────────────────────────\n`
      );
    }
    return { id, queued: true, delivered: false };
  }

  // Kick the worker without waiting for it. Deliberately not awaited, and it
  // swallows its own errors -- see the note above about why a send failure
  // must not propagate into this request.
  setTimeout(() => {
    deliverOutbox().catch((err) => console.error('[mail] drain failed:', err.message));
  }, 0).unref();

  return { id, queued: true, delivered: false };
}

/* --------------------------------------------------------------- the queue */

/** One drain at a time, so the worker tick and a fresh send cannot overlap. */
let draining = false;

/**
 * Delivers every message that is due. Safe to call at any time; does nothing
 * without a transport.
 */
export async function deliverOutbox({ limit = 25 } = {}) {
  if (!isLive() || draining) return { sent: 0, failed: 0, skipped: true };
  draining = true;
  let sent = 0;
  let failed = 0;

  try {
    const due = all(
      `SELECT id, to_addr, subject, body_text, body_html, reply_to, cc, headers, attempts, next_attempt_at
         FROM email_outbox
        WHERE sent_at IS NULL
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at <= ?
        ORDER BY id
        LIMIT ?`,
      [nowIso(), limit]
    );

    for (const row of due) {
      const attempt = row.attempts + 1;

      // Never attempt a reserved documentation domain: see config.mail
      // .suppressDomains. Recorded as held with a reason, not as a failure, so
      // it neither retries nor shows up as something to fix.
      if (isSuppressed(row.to_addr)) {
        run(
          `UPDATE email_outbox
              SET next_attempt_at = NULL, last_attempt_at = ?, error = ?
            WHERE id = ?`,
          [nowIso(), 'not sent: address is a reserved documentation domain', row.id]
        );
        continue;
      }

      // Claim the row before sending, so two drains cannot both deliver it.
      // The in-process `draining` flag is not enough: `npm run mail:check
      // --drain` is a second process against the same database, and the script
      // invites you to run it while the site is up. Without this, an
      // invitation goes out twice.
      //
      // Optimistic: the update only succeeds if next_attempt_at is still what
      // the SELECT saw. The claim parks the row far enough ahead that if this
      // process dies mid-send it is retried later rather than stuck for ever.
      const claimed = run(
        `UPDATE email_outbox
            SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?
          WHERE id = ? AND sent_at IS NULL AND next_attempt_at = ?`,
        [
          attempt,
          nowIso(),
          new Date(Date.now() + 10 * 60_000).toISOString(),
          row.id,
          row.next_attempt_at,
        ]
      );
      if (claimed.changes === 0) continue;

      try {
        await sendViaSmtp(row);
        run(
          `UPDATE email_outbox
              SET sent_at = ?, attempts = ?, last_attempt_at = ?,
                  next_attempt_at = NULL, error = NULL
            WHERE id = ?`,
          [nowIso(), attempt, nowIso(), row.id]
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        const message = redact(err.message).slice(0, 500);
        const wait = BACKOFF_MINUTES[attempt - 1];
        const next =
          wait == null ? null : new Date(Date.now() + wait * 60_000).toISOString();

        run(
          `UPDATE email_outbox
              SET attempts = ?, last_attempt_at = ?, next_attempt_at = ?, error = ?
            WHERE id = ?`,
          [attempt, nowIso(), next, message, row.id]
        );

        // Addresses are logged, message bodies are not: they carry live reset
        // tokens, and logs are the one place nobody thinks to protect.
        console.error(
          next
            ? `[mail] #${row.id} to ${row.to_addr} failed (attempt ${attempt}), retrying in ${wait}m: ${message}`
            : `[mail] #${row.id} to ${row.to_addr} GIVING UP after ${attempt} attempts: ${message}`
        );
      }
    }
  } finally {
    draining = false;
  }

  return { sent, failed, skipped: false };
}

/**
 * Puts a message back in the queue, from attempt zero.
 *
 * For the case where delivery failed because of something the operator has
 * since fixed -- wrong password, blocked port, unverified sender -- and for
 * pulling one useful message out of a backlog that was queued before SMTP
 * existed.
 */
export function requeueMail(id) {
  const row = get('SELECT id, sent_at FROM email_outbox WHERE id = ?', [Number(id)]);
  if (!row || row.sent_at) return false;
  run(
    'UPDATE email_outbox SET attempts = 0, next_attempt_at = ?, error = NULL WHERE id = ?',
    [nowIso(), row.id]
  );
  if (isLive()) {
    setTimeout(() => {
      deliverOutbox().catch((err) => console.error('[mail] drain failed:', err.message));
    }, 0).unref();
  }
  return true;
}

let workerTimer = null;

/**
 * Starts the periodic drain. Called from server.js rather than app.js so that
 * importing the app (tests, scripts) does not start a timer that sends mail.
 */
export function startMailWorker() {
  if (!isLive() || workerTimer) return false;
  const everyMs = Math.max(15, config.mail.pollSeconds) * 1000;

  // Retries that came due while the process was down go out on boot.
  deliverOutbox().catch((err) => console.error('[mail] initial drain failed:', err.message));

  workerTimer = setInterval(() => {
    deliverOutbox().catch((err) => console.error('[mail] drain failed:', err.message));
  }, everyMs);
  workerTimer.unref(); // never hold the process open on account of the mail queue
  return true;
}

export function stopMailWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
}

/** Messages still waiting, and messages the worker has given up on. */
export function outboxHealth() {
  return get(`
    SELECT
      COUNT(*) FILTER (WHERE sent_at IS NULL AND next_attempt_at IS NOT NULL) AS pending,
      COUNT(*) FILTER (WHERE sent_at IS NULL AND next_attempt_at IS NULL AND error IS NOT NULL) AS abandoned,
      COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS sent
    FROM email_outbox`);
}

/* ----------------------------------------------------------------- transport */

let transport = null;

/**
 * The nodemailer transport, built once and pooled.
 *
 * Imported lazily so the package is only loaded when mail is actually being
 * sent, and so an outbox-only deployment still runs if it is missing.
 */
async function smtpTransport() {
  if (transport) return transport;

  const { host, port, secure, user, pass, requireTls, allowInvalidCerts } = config.mail.smtp;

  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch (err) {
    throw new Error(
      `MAIL_TRANSPORT=smtp needs the nodemailer package: run "npm install". (${err.message})`
    );
  }

  transport = nodemailer.createTransport({
    host,
    port,
    secure, // true for implicit TLS on 465; false for STARTTLS on 587
    auth: user ? { user, pass } : undefined,
    // Refuse to fall back to an unencrypted session on 587. Without this a
    // server that simply omits STARTTLS gets the password in the clear.
    requireTLS: requireTls && !secure,
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    tls: allowInvalidCerts ? { rejectUnauthorized: false } : undefined,
  });

  return transport;
}

export async function closeMailTransport() {
  if (transport) transport.close();
  transport = null;
}

/** Checks host, port and credentials without sending anything. */
export async function verifyTransport() {
  const t = await smtpTransport();
  try {
    await t.verify();
  } catch (err) {
    throw new Error(redact(err.message));
  }
  return true;
}

/**
 * Images an HTML message refers to by `cid:` are attached to the message itself,
 * so they show immediately in Gmail, Outlook and Apple Mail with no remote
 * image to block and no dependence on the website being reachable. Today that
 * is one small badge (4.8 KB), sent only with messages that use it.
 */
export function inlineAttachments(html) {
  if (!html || !html.includes(`cid:${LOGO_CID}`)) return [];
  return [{
    filename: 'eaa-chapter-1699.png',
    path: path.join(config.publicDir, 'img', 'eaa-email-badge.png'),
    cid: LOGO_CID,
    contentDisposition: 'inline',
  }];
}

async function sendViaSmtp({ to_addr: to, subject, body_text: text, body_html: html, reply_to: replyTo, cc, headers }) {
  const t = await smtpTransport();
  // Documentation-only domains (example.com and friends) cannot receive mail; leave them out of the Cc.
  const copies = String(cc ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a && !isSuppressed(a));
  await t.sendMail({
    from: config.mail.from,
    to,
    ...(copies.length ? { cc: copies } : {}),
    subject,
    text,
    ...(html ? { html } : {}),
    ...(inlineAttachments(html).length ? { attachments: inlineAttachments(html) } : {}),
    ...(headers ? { headers: JSON.parse(headers) } : {}),
    ...(replyTo || config.mail.replyTo ? { replyTo: replyTo || config.mail.replyTo } : {}),
  });
}

/**
 * Strips the SMTP password out of anything on its way to a log or the
 * database. Nodemailer does not put credentials in its errors, but errors
 * quote server dialogue and this is not the place to rely on that.
 */
function redact(text) {
  const pass = config.mail.smtp.pass;
  let out = String(text ?? '');
  // Below this length the substring match does more harm than good: a
  // two-character value collides with ordinary English and turns a useful
  // diagnostic into nonsense (a one-character password rewrote
  // "connect ECONNREFUSED" as "connec<redacted> ECONNREFUSED"). Nothing that
  // short is a secret worth protecting anyway.
  if (pass.length < 8) return out;
  for (const form of [pass, Buffer.from(pass).toString('base64')]) {
    out = out.split(form).join('<redacted>');
  }
  return out;
}

export function recentOutbox(limit = 50) {
  return all(
    `SELECT id, to_addr, subject, sent_at, error, created_at, attempts, next_attempt_at
       FROM email_outbox ORDER BY id DESC LIMIT ?`,
    [Math.min(Number(limit) || 50, 200)]
  );
}

/* --------------------------------------------------------------- templates */

const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px; border-bottom:1px solid #e3e8ee;">${rows}</table>`;
const sign = (line = 'Blue skies,<br>EAA Chapter 1699') => para(line, 'margin-bottom:24px;');


export function passwordResetEmail({ name, link, ttlMinutes }) {
  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to set a new password for your EAA Chapter 1699 members account.',
    'If that was you, open the link below within the next ' + ttlMinutes + ' minutes:',
    '',
    link,
    '',
    'The link works once and then expires. If you did not ask for this, you can',
    'ignore this email -- your current password still works and nothing has changed.',
    '',
    'Blue skies,',
    'EAA Chapter 1699 - South Albany Airport (4B0)',
  ].join('\n');
  const html = renderEmail({
    preheader: `Your link to set a new password works for ${ttlMinutes} minutes.`,
    eyebrow: 'Password reset',
    title: 'Set a new password',
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para('Someone asked to set a new password for your EAA Chapter 1699 members account. If that was you, use the button below within the next ' + esc(ttlMinutes) + ' minutes.'),
      button('Choose a new password', link),
      linkFallback(link),
      para('The link works once and then expires. If you did not ask for this, you can ignore this email: your current password still works and nothing has changed.'),
      sign(),
    ].join(''),
    footerHtml: plainFooter('You are getting this because a password reset was asked for on your members account.'),
  });
  return { subject: 'Reset your EAA Chapter 1699 password', text, html };
}

export function inviteEmail({ name, link, invitedBy, ttlDays }) {
  const text = [
    `Hi ${name},`,
    '',
    `${invitedBy} has set up a Members Corner account for you at EAA Chapter 1699.`,
    '',
    'Choose your password here (link valid for ' + ttlDays + ' days):',
    '',
    link,
    '',
    'Inside you will find the chapter blog and the Tool Locker -- the shared',
    'list of tools members are willing to lend to each other.',
    '',
    'Blue skies,',
    'EAA Chapter 1699 - South Albany Airport (4B0)',
  ].join('\n');
  const html = renderEmail({
    preheader: `${invitedBy} has set up a members account for you.`,
    eyebrow: 'Welcome',
    title: 'Your members account is ready',
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para(`${esc(invitedBy)} has set up a Members Corner account for you at EAA Chapter 1699. Choose your password to sign in. The link is valid for ${esc(ttlDays)} days.`),
      button('Choose your password', link),
      linkFallback(link),
      para('Inside you will find the chapter blog and the Tool Locker, the shared list of tools members are willing to lend to each other.'),
      sign(),
    ].join(''),
    footerHtml: plainFooter('You are getting this because the chapter set up a members account for you.'),
  });
  return { subject: 'Your EAA Chapter 1699 members account', text, html };
}

export function borrowRequestEmail({
  ownerName,
  requesterName,
  toolName,
  message,
  link,
  neededFrom = null,
  neededTo = null,
}) {
  const when = dateRange(neededFrom, neededTo);
  const text = [
    `Hi ${ownerName},`,
    '',
    `${requesterName} would like to borrow your ${toolName}.`,
    // When they want it is the first thing an owner needs in order to answer,
    // so it goes above the note rather than being left in the dashboard.
    ...(when ? ['', `When: ${when}`] : []),
    '',
    'Their note:',
    message,
    '',
    'Nothing happens until you say so. Open the Tool Locker requests page to',
    'approve or decline, and to add a note back to them:',
    '',
    link,
    '',
    'Approving marks the tool as on loan; marking it returned later puts it',
    'back on the available list. Either way they get an email, so you do not',
    'have to chase anybody down.',
    '',
    'EAA Chapter 1699 Tool Locker',
  ].join('\n');
  const html = renderEmail({
    preheader: `${requesterName} would like to borrow your ${toolName}.`,
    eyebrow: 'Tool Locker',
    title: `Borrow request: ${toolName}`,
    bodyHtml: [
      para(`Hi ${esc(ownerName)},`),
      para(`${esc(requesterName)} would like to borrow your ${esc(toolName)}.`),
      table(detailRow('Tool', esc(toolName)) + detailRow('From', esc(requesterName)) + (when ? detailRow('When', esc(when)) : '')),
      para('Their note:', 'margin-bottom:6px;'),
      quote(message),
      para('Nothing happens until you say so. Approve or decline on the Tool Locker requests page, and add a note back to them if you like.'),
      button('Open the requests', link),
      para('Approving marks the tool as on loan; marking it returned later puts it back on the available list. Either way they get an email, so you do not have to chase anybody down.', 'font-size:14px; color:#4a5b6b;'),
      sign('EAA Chapter 1699 Tool Locker'),
    ].join(''),
    footerHtml: plainFooter('You are getting this because someone asked to borrow one of your tools.'),
  });
  return { subject: `Borrow request: ${toolName}`, text, html };
}

/** "Aug 20, 9:00 AM – Aug 23, 5:00 PM", in the chapter's local time. */
function dateRange(from, to) {
  const fmt = (v) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(v));
  if (!from && !to) return null;
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  return fmt(from || to);
}

export function borrowDecisionEmail({ requesterName, toolName, ownerName, status, reply, link }) {
  // Three outcomes the owner can send. Anything unexpected falls back to the
  // neutral wording rather than claiming the request was declined.
  const outcomes = {
    approved: {
      subject: `Your borrow request for ${toolName} was approved`,
      heading: 'Your request was approved',
      line: `${ownerName} approved your request to borrow the ${toolName}.`,
    },
    declined: {
      subject: `Your borrow request for ${toolName} was declined`,
      heading: 'Your request was declined',
      line: `${ownerName} declined your request to borrow the ${toolName}.`,
    },
    returned: {
      subject: `The ${toolName} has been marked as returned`,
      heading: 'Marked as returned',
      line: `${ownerName} has marked the ${toolName} as returned. Thank you for bringing it back.`,
    },
  };
  const outcome = outcomes[status] ?? {
    subject: `Update on your borrow request for ${toolName}`,
    heading: 'An update on your request',
    line: `${ownerName} updated your request to borrow the ${toolName}.`,
  };
  const text = [
    `Hi ${requesterName},`,
    '',
    outcome.line,
    reply ? `\nTheir note:\n${reply}\n` : '',
    `Details: ${link}`,
    '',
    'EAA Chapter 1699 Tool Locker',
  ].join('\n');
  const html = renderEmail({
    preheader: outcome.line,
    eyebrow: 'Tool Locker',
    title: outcome.heading,
    subtitle: toolName,
    bodyHtml: [
      para(`Hi ${esc(requesterName)},`),
      para(esc(outcome.line)),
      ...(reply ? [para('Their note:', 'margin-bottom:6px;'), quote(reply)] : []),
      button('See the details', link),
      sign('EAA Chapter 1699 Tool Locker'),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you asked to borrow a tool.'),
  });
  return { subject: outcome.subject, text, html };
}

export function applicationReceivedEmail({ name }) {
  const text = [
    `Hi ${name},`,
    '',
    'Thanks for asking to join EAA Chapter 1699. A chapter officer reviews',
    'every request by hand, so give us a few days — we are all volunteers.',
    '',
    'If we approve it you will get a second email with a link to set your',
    'own password. We will never send you a password, and we could not even',
    'if we wanted to: the site only ever stores a one-way hash of it.',
    '',
    'In the meantime, come to something. Everything on our events calendar is',
    'open to visitors, and turning up is a much better introduction than any',
    'amount of paperwork.',
    '',
    'Blue skies,',
    'EAA Chapter 1699 - South Albany Airport (4B0)',
  ].join('\n');
  const html = renderEmail({
    preheader: 'A chapter officer reviews every request by hand.',
    eyebrow: 'Membership',
    title: 'We got your request',
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para('Thanks for asking to join EAA Chapter 1699. A chapter officer reviews every request by hand, so give us a few days: we are all volunteers.'),
      para('If we approve it you will get a second email with a link to set your own password. We will never send you a password, and we could not even if we wanted to: the site only ever stores a one-way hash of it.'),
      para('In the meantime, come to something. Everything on our events calendar is open to visitors, and turning up is a much better introduction than any amount of paperwork.'),
      sign(),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you asked to join the chapter on our website.'),
  });
  return { subject: 'We got your EAA Chapter 1699 membership request', text, html };
}

export function applicationNotificationEmail({ name, email, interest, message, link }) {
  const text = [
    `${name} <${email}> has asked to join the chapter.`,
    '',
    `What brings them here: ${interest || 'not stated'}`,
    '',
    'Their note:',
    message,
    '',
    `Review it here: ${link}`,
    '',
    'EAA Chapter 1699',
  ].join('\n');
  const html = renderEmail({
    preheader: `${name} has asked to join the chapter.`,
    eyebrow: 'Membership request',
    title: name,
    bodyHtml: [
      para(`${esc(name)} has asked to join the chapter.`),
      table(detailRow('Name', esc(name)) + detailRow('Email', esc(email)) + detailRow('Interest', esc(interest || 'not stated'))),
      para('Their note:', 'margin-bottom:6px;'),
      quote(message),
      button('Review the request', link),
      sign('EAA Chapter 1699'),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you look after membership requests for the chapter.'),
  });
  return { subject: `Membership request from ${name}`, text, html };
}

export function applicationDeclinedEmail({ name, note }) {
  const text = [
    `Hi ${name},`,
    '',
    'Thanks for your interest in EAA Chapter 1699. We are not able to set up',
    'a Members Corner account for you at the moment.',
    note ? `\n${note}\n` : '',
    'This does not shut any doors: our events are open to everyone, and you',
    'are very welcome at a fly-in breakfast or a meeting night. Come and say',
    'hello, and do ask again.',
    '',
    'Blue skies,',
    'EAA Chapter 1699 - South Albany Airport (4B0)',
  ].join('\n');
  const html = renderEmail({
    preheader: 'About your membership request.',
    eyebrow: 'Membership',
    title: 'About your request',
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para('Thanks for your interest in EAA Chapter 1699. We are not able to set up a Members Corner account for you at the moment.'),
      ...(note ? [quote(note)] : []),
      para('This does not shut any doors: our events are open to everyone, and you are very welcome at a fly-in breakfast or a meeting night. Come and say hello, and do ask again.'),
      sign(),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you asked to join the chapter on our website.'),
  });
  return { subject: 'About your EAA Chapter 1699 membership request', text, html };
}

export function contactNotificationEmail({ name, email, topic, message }) {
  return {
    subject: `[eaa1699.org] ${topic || 'Website message'} from ${name}`,
    text: [
      `From:  ${name} <${email}>`,
      `Topic: ${topic || 'General'}`,
      '',
      message,
    ].join('\n'),
  };
}

/**
 * A reply to a contact-form message, sent from the site. The officer's own
 * address never appears: it goes out from the chapter's address, signed with
 * their first name only.
 */
export function contactReplyEmail({ name, topic, body, signedBy, original }) {
  const quoted = String(original)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return {
    subject: `Re: ${topic || 'your message to EAA Chapter 1699'}`,
    text: [
      `Hi ${name},`,
      '',
      body,
      '',
      'Blue skies,',
      `${signedBy}`,
      'EAA Chapter 1699 - South Albany Airport (4B0)',
      '',
      'You wrote:',
      quoted,
    ].join('\n'),
  };
}

/** A board member has sent a document for a President or Vice President to review. */
export function documentSubmittedEmail({ reviewerName, submitterName, title, kind, version, link }) {
  const text = [
    `Hi ${reviewerName},`,
    '',
    `${submitterName} has sent ${kind.toLowerCase()} "${title}" (version ${version}) for review.`,
    '',
    'Open it on the chapter site to read it and approve it, or ask for changes:',
    '',
    link,
    '',
    'Either the President or the Vice President can approve. Nothing is shared',
    'with members until it has been approved and published.',
    '',
    'EAA Chapter 1699',
  ].join('\n');
  const html = renderEmail({
    preheader: `${submitterName} sent "${title}" for your review.`,
    eyebrow: 'Needs your review',
    title,
    subtitle: `${kind}, version ${version}`,
    bodyHtml: [
      para(`Hi ${esc(reviewerName)},`),
      para(`${esc(submitterName)} has sent ${esc(kind.toLowerCase())} &ldquo;${esc(title)}&rdquo; (version ${esc(version)}) for review. Open it to read it and approve it, or ask for changes.`),
      button('Open the document', link),
      para('Either the President or the Vice President can approve. Nothing is shared with members until it has been approved and published.', 'font-size:14px; color:#4a5b6b;'),
      sign('EAA Chapter 1699'),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you are the chapter&rsquo;s President or Vice President. Messages about approvals are not optional.'),
  });
  return { subject: `For your review: ${title}`, text, html };
}

/** The decision on a document, for whoever sent it for review. */
export function documentReviewedEmail({ name, reviewerName, reviewerOffice, title, decision, comment, link }) {
  const approved = decision === 'approved';
  const line = approved
    ? `${reviewerName} (${reviewerOffice}) approved "${title}".`
    : `${reviewerName} (${reviewerOffice}) asked for changes to "${title}".`;
  const next = approved
    ? 'It is not visible to members yet. Publish it from the document page when you are ready.'
    : 'Upload a corrected version and send it for review again.';
  const text = [
    `Hi ${name},`,
    '',
    line,
    comment ? `\nTheir note:\n${comment}\n` : '',
    next,
    '',
    link,
    '',
    'EAA Chapter 1699',
  ].join('\n');
  const html = renderEmail({
    preheader: line,
    eyebrow: approved ? 'Approved' : 'Changes requested',
    title,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para(esc(line)),
      ...(comment ? [para('Their note:', 'margin-bottom:6px;'), quote(comment)] : []),
      para(esc(next)),
      button('Open the document', link),
      sign('EAA Chapter 1699'),
    ].join(''),
    footerHtml: plainFooter('You are getting this because you sent this document for review. Messages about approvals are not optional.'),
  });
  return { subject: approved ? `Approved: ${title}` : `Changes requested: ${title}`, text, html };
}

/**
 * A reminder for an event: `lead` is 'day' (tomorrow) or 'week' (a week away).
 * `when`, `where` and the links are already formatted.
 */
export function eventReminderEmail({
  name, title, kindLabel = 'Event', lead = 'day', when, where, summary, rainDate, link: eventLink,
  directionsLink = null, unsubscribeLink, accountLink,
}) {
  const week = lead === 'week';
  const text = [
    `Hi ${name},`,
    '',
    week
      ? `${title} is a week away: ${when.long}. Here are the details so you can plan.`
      : `A quick reminder: ${title} is tomorrow, ${when.long}.`,
    ...(where ? ['', `Where: ${where}`] : []),
    ...(summary ? ['', summary] : []),
    ...(rainDate ? ['', `Rain date: ${rainDate}`] : []),
    '',
    `Details: ${eventLink}`,
    '',
    week ? 'We hope you can make it.' : 'See you there.',
    'EAA Chapter 1699',
    '',
    '--',
    `Stop these reminders: ${unsubscribeLink}`,
    `Or choose what you get on your account page: ${accountLink}`,
  ].join('\n');

  const details = [
    detailRow('When', esc(when.long)),
    ...(where
      ? [detailRow('Where', `${esc(where)}${directionsLink ? `<br>${emailLink(directionsLink, 'Get directions')}` : ''}`)]
      : []),
  ].join('');

  const html = renderEmail({
    preheader: week ? `${title} is a week away, ${when.long}.` : `${title} is tomorrow, ${when.long}.`,
    eyebrow: week ? 'Coming up in a week' : `${kindLabel} reminder`,
    title,
    subtitle: `${week ? 'In a week' : 'Tomorrow'} \u00b7 ${when.long}`,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para(week ? 'This is a week away. Here are the details so you can plan.' : 'A quick reminder that this is tomorrow.'),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px; border-bottom:1px solid #e3e8ee;">${details}</table>`,
      ...(summary ? [para(esc(summary))] : []),
      ...(rainDate
        ? [`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td bgcolor="#fdeed6" style="background:#fdeed6; border-radius:10px; padding:12px 16px; font-size:15px; line-height:1.5; color:#7c4a08;"><strong>Rain date:</strong> ${esc(rainDate)}</td></tr></table>`]
        : []),
      button('See the details', eventLink),
      para(week ? 'We hope you can make it.<br>EAA Chapter 1699' : 'See you there.<br>EAA Chapter 1699', 'margin-bottom:24px;'),
    ].join(''),
    footerHtml: [
      'You are getting this because you are a member of EAA Chapter 1699 and event reminders are switched on.',
      `<br>${emailLink(unsubscribeLink, 'Stop these reminders')} &nbsp;&middot;&nbsp; ${emailLink(accountLink, 'Email preferences')}`,
      '<br><br>EAA Chapter 1699 &middot; South Albany Airport (4B0) &middot; Selkirk, New York',
    ].join(''),
  });

  return { subject: week ? `Coming up: ${title}, ${when.short}` : `Reminder: ${title}, ${when.short}`, text, html };
}

/**
 * A change to an event, or its cancellation, written by an editor. `message` is
 * the editor's own words; the rest is the event as it stands.
 */
export function eventUpdateEmail({
  name, title, cancelled = false, message, when, where, link: eventLink, directionsLink = null,
  unsubscribeLink, accountLink,
}) {
  const text = [
    `Hi ${name},`,
    '',
    cancelled ? `${title} has been cancelled.` : `A change to ${title}.`,
    '',
    message,
    '',
    ...(cancelled ? [`It was to be on ${when.long}.`] : [`When: ${when.long}`, ...(where ? [`Where: ${where}`] : [])]),
    '',
    `Details: ${eventLink}`,
    '',
    'EAA Chapter 1699',
    '',
    '--',
    `Stop these messages: ${unsubscribeLink}`,
    `Or choose what you get on your account page: ${accountLink}`,
  ].join('\n');

  const rows = cancelled
    ? ''
    : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px; border-bottom:1px solid #e3e8ee;">${detailRow('When', esc(when.long))}${
        where ? detailRow('Where', `${esc(where)}${directionsLink ? `<br>${emailLink(directionsLink, 'Get directions')}` : ''}`) : ''
      }</table>`;

  const html = renderEmail({
    preheader: cancelled ? `${title} has been cancelled.` : `A change to ${title}.`,
    eyebrow: cancelled ? 'Event cancelled' : 'Event update',
    title,
    subtitle: cancelled ? `Was ${when.long}` : when.long,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      ...paragraphs(message).map((p) => para(esc(p).replace(/\n/g, '<br>'))),
      rows,
      button('See the event page', eventLink),
      para('EAA Chapter 1699', 'margin-bottom:24px;'),
    ].join(''),
    footerHtml: [
      'You are getting this because you are a member of EAA Chapter 1699 and event reminders and updates are switched on.',
      `<br>${emailLink(unsubscribeLink, 'Stop these messages')} &nbsp;&middot;&nbsp; ${emailLink(accountLink, 'Email preferences')}`,
      '<br><br>EAA Chapter 1699 &middot; South Albany Airport (4B0) &middot; Selkirk, New York',
    ].join(''),
  });

  return { subject: cancelled ? `Cancelled: ${title}, ${when.short}` : `Update: ${title}`, text, html };
}

/** "- a\n* b\n1. c" -> ['a', 'b', 'c']. One agenda item per line, bullets and numbers optional. */
export function agendaItems(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
}

/** Blank-line-separated paragraphs, with single line breaks kept. */
const paragraphs = (text) =>
  String(text ?? '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** The notice that goes to members ahead of a meeting, once the President or Vice President has approved it. */
export function meetingNoticeEmail({
  name, title, when, where, speaker, agenda, note, rainDate, link: eventLink, directionsLink = null,
  unsubscribeLink, accountLink,
}) {
  const items = agendaItems(agenda);
  const text = [
    `Hi ${name},`,
    '',
    `We are meeting on ${when.long}.`,
    ...(note ? ['', note] : []),
    '',
    `When: ${when.long}`,
    ...(where ? [`Where: ${where}`] : []),
    ...(speaker ? [`Speaker: ${speaker}`] : []),
    ...(items.length ? ['', 'On the agenda:', ...items.map((i) => `  - ${i}`)] : []),
    ...(rainDate ? ['', `Rain date: ${rainDate}`] : []),
    '',
    `Details: ${eventLink}`,
    '',
    'We hope to see you there.',
    'EAA Chapter 1699',
    '',
    '--',
    `Stop meeting notices: ${unsubscribeLink}`,
    `Or choose what you get on your account page: ${accountLink}`,
  ].join('\n');

  const rows = [
    detailRow('When', esc(when.long)),
    ...(where ? [detailRow('Where', `${esc(where)}${directionsLink ? `<br>${emailLink(directionsLink, 'Get directions')}` : ''}`)] : []),
    ...(speaker ? [detailRow('Speaker', esc(speaker))] : []),
  ].join('');

  const html = renderEmail({
    preheader: `${title}, ${when.long}.`,
    eyebrow: 'Meeting notice',
    title,
    subtitle: when.long,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      ...paragraphs(note).map((p) => para(esc(p).replace(/\n/g, '<br>'))),
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px; border-bottom:1px solid #e3e8ee;">${rows}</table>`,
      ...(items.length
        ? [
            '<div style="margin:0 0 8px; font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#7d8b98;">On the agenda</div>',
            `<ul style="margin:0 0 20px; padding-left:20px; font-size:16px; line-height:1.6; color:#17252f;">${items.map((i) => `<li style="margin-bottom:4px;">${esc(i)}</li>`).join('')}</ul>`,
          ]
        : []),
      ...(rainDate
        ? [`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td bgcolor="#fdeed6" style="background:#fdeed6; border-radius:10px; padding:12px 16px; font-size:15px; line-height:1.5; color:#7c4a08;"><strong>Rain date:</strong> ${esc(rainDate)}</td></tr></table>`]
        : []),
      button('See the meeting details', eventLink),
      para('We hope to see you there.<br>EAA Chapter 1699', 'margin-bottom:24px;'),
    ].join(''),
    footerHtml: [
      'You are getting this because you are a member of EAA Chapter 1699 and meeting notices are switched on.',
      `<br>${emailLink(unsubscribeLink, 'Stop meeting notices')} &nbsp;&middot;&nbsp; ${emailLink(accountLink, 'Email preferences')}`,
      '<br><br>EAA Chapter 1699 &middot; South Albany Airport (4B0) &middot; Selkirk, New York',
    ].join(''),
  });

  return { subject: `Meeting notice: ${title}, ${when.short}`, text, html };
}

/**
 * A short message to a board member about something that needs them: a notice to
 * approve, a reminder that it is still waiting, an approval that no longer stands.
 */
export function boardAlertEmail({ name, subject, eyebrow, heading, lines, buttonLabel, link: pageLink, office }) {
  const text = [
    `Hi ${name},`,
    '',
    ...lines,
    '',
    `${buttonLabel}: ${pageLink}`,
    '',
    'EAA Chapter 1699',
  ].join('\n');
  const html = renderEmail({
    preheader: lines[0],
    eyebrow,
    title: heading,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      ...lines.map((l) => para(esc(l))),
      button(buttonLabel, pageLink),
      para('EAA Chapter 1699', 'margin-bottom:24px;'),
    ].join(''),
    footerHtml: `You are getting this because you are the chapter's ${esc(office)}. Messages about approvals are not optional.<br><br>EAA Chapter 1699 &middot; South Albany Airport (4B0) &middot; Selkirk, New York`,
  });
  return { subject, text, html };
}

/** Told to members when approved minutes are published: a link to read them on the site, never the file. */
export function minutesPublishedEmail({ name, title, link: pageLink, unsubscribeLink, accountLink }) {
  const text = [
    `Hi ${name},`,
    '',
    `The minutes are now available: ${title}.`,
    '',
    'They are on the chapter website for members. Sign in to read them:',
    '',
    pageLink,
    '',
    'EAA Chapter 1699',
    '',
    '--',
    `Stop these messages: ${unsubscribeLink}`,
    `Or choose what you get on your account page: ${accountLink}`,
  ].join('\n');
  const html = renderEmail({
    preheader: `${title} are now on the chapter website.`,
    eyebrow: 'Minutes published',
    title,
    bodyHtml: [
      para(`Hi ${esc(name)},`),
      para('The minutes have been approved and are now on the chapter website for members. Sign in to read them.'),
      button('Read the minutes', pageLink),
      para('EAA Chapter 1699', 'margin-bottom:24px;'),
    ].join(''),
    footerHtml: [
      'You are getting this because you are a member of EAA Chapter 1699 and meeting notices are switched on.',
      `<br>${emailLink(unsubscribeLink, 'Stop these messages')} &nbsp;&middot;&nbsp; ${emailLink(accountLink, 'Email preferences')}`,
      '<br><br>EAA Chapter 1699 &middot; South Albany Airport (4B0) &middot; Selkirk, New York',
    ].join(''),
  });
  return { subject: `Minutes available: ${title}`, text, html };
}
