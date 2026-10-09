import config from '../config.js';
import { TZ } from './localtime.js';
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

export async function sendMail({ to, subject, text, html = null, replyTo = null }) {
  const now = nowIso();
  const info = run(
    `INSERT INTO email_outbox
       (to_addr, subject, body_text, body_html, reply_to, created_at, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    // next_attempt_at NULL when there is no transport: the row is a record,
    // not a pending delivery, so turning SMTP on later does not flush it.
    [to, subject, text, html, replyTo, now, isLive() ? now : null]
  );
  const id = Number(info.lastInsertRowid);

  if (!isLive()) {
    if (config.isDev) {
      console.log(
        `\n──────── outbox #${id} ────────\nTo:      ${to}\nSubject: ${subject}\n\n${text}\n────────────────────────────\n`
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
      `SELECT id, to_addr, subject, body_text, body_html, reply_to, attempts, next_attempt_at
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

async function sendViaSmtp({ to_addr: to, subject, body_text: text, body_html: html, reply_to: replyTo }) {
  const t = await smtpTransport();
  await t.sendMail({
    from: config.mail.from,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
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

export function passwordResetEmail({ name, link, ttlMinutes }) {
  return {
    subject: 'Reset your EAA Chapter 1699 password',
    text: [
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
    ].join('\n'),
  };
}

export function inviteEmail({ name, link, invitedBy, ttlDays }) {
  return {
    subject: 'Your EAA Chapter 1699 members account',
    text: [
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
    ].join('\n'),
  };
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
  return {
    subject: `Borrow request: ${toolName}`,
    text: [
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
    ].join('\n'),
  };
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
  const verdict = status === 'approved' ? 'approved' : 'declined';
  return {
    subject: `Your borrow request for ${toolName} was ${verdict}`,
    text: [
      `Hi ${requesterName},`,
      '',
      `${ownerName} ${verdict} your request to borrow the ${toolName}.`,
      reply ? `\nTheir note:\n${reply}\n` : '',
      `Details: ${link}`,
      '',
      'EAA Chapter 1699 Tool Locker',
    ].join('\n'),
  };
}

export function applicationReceivedEmail({ name }) {
  return {
    subject: 'We got your EAA Chapter 1699 membership request',
    text: [
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
    ].join('\n'),
  };
}

export function applicationNotificationEmail({ name, email, interest, message, link }) {
  return {
    subject: `Membership request from ${name}`,
    text: [
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
    ].join('\n'),
  };
}

export function applicationDeclinedEmail({ name, note }) {
  return {
    subject: 'About your EAA Chapter 1699 membership request',
    text: [
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
    ].join('\n'),
  };
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
