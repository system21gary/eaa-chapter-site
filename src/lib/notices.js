import crypto from 'node:crypto';
import { all, get, run, nowIso, transaction } from '../db/index.js';
import * as Users from '../models/users.js';
import * as Posts from '../models/posts.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { sendMail, meetingNoticeEmail, boardAlertEmail, agendaItems } from './mailer.js';
import { unsubscribeUrl, unsubscribeHeaders } from './unsubscribe.js';
import { whenOf, whereOf, localDayAt, localDate, rainDateText } from './event-format.js';
import { TZ } from './localtime.js';
import { mapUrl } from '../views/filters.js';

/**
 * Meeting notices.
 *
 *   about 14 days out   the site drafts a notice and tells the President, Vice President and Secretary
 *   about 10 days out   it is due to go to members; an approved notice sends, an unapproved
 *                       one is chased daily and NEVER sends
 *   48 hours out        too close to be useful: anything still unsent is cancelled
 *
 * The approval covers the event's title, date and place as they stood when it was
 * approved. If any of those change afterwards -- or the notice is edited -- the
 * approval is withdrawn and the approvers are told, rather than sending something
 * nobody signed off. A meeting that moves to another date gets a fresh notice.
 */
export const DRAFT_DAYS = 14;
export const SEND_DAYS = 10;
export const CUTOFF_HOURS = 48;

export const STATUS_LABELS = {
  draft: 'Needs approval',
  approved: 'Approved',
  sending: 'Sending',
  sent: 'Sent',
  cancelled: 'Cancelled',
};

const DAY = 86_400_000;

/* ----------------------------------------------------------------- lookup */

const NOTICE_SQL = `
  SELECT n.*, e.title AS event_title, e.slug AS event_slug, e.starts_at, e.ends_at, e.all_day, e.rain_date,
         e.location_name, e.address, e.city, e.state, e.latitude, e.longitude, e.summary AS event_summary,
         e.status AS event_status, e.kind AS event_kind
    FROM notices n LEFT JOIN events e ON e.id = n.event_id
`;

export function getNotice(id) {
  if (!Number.isInteger(Number(id))) return null;
  return get(`${NOTICE_SQL} WHERE n.id = ?`, [Number(id)]) ?? null;
}

/** Newest meeting first; cancelled ones only if recent, so the list stays about what matters. */
export function listRecent(limit = 12) {
  return all(`${NOTICE_SQL} ORDER BY COALESCE(e.starts_at, n.created_at) DESC LIMIT ?`, [limit]);
}

/** Drafts that someone has to approve, soonest to go out first. */
export function listAwaitingApproval() {
  return all(`${NOTICE_SQL} WHERE n.status = 'draft' AND e.status = 'published' ORDER BY n.send_at`);
}

export function awaitingApprovalCount() {
  return get("SELECT COUNT(*) AS n FROM notices WHERE status = 'draft'").n;
}

export function listLog(noticeId) {
  return all('SELECT * FROM notice_events WHERE notice_id = ? ORDER BY id DESC', [Number(noticeId)]);
}

function actorLabel(user) {
  if (!user) return 'The site';
  const office = user.board_role ? ` (${Users.BOARD_ROLES[user.board_role]})` : '';
  return `${Users.displayName(user)}${office}`;
}

function log(noticeId, action, user = null, detail = null) {
  run(
    'INSERT INTO notice_events (notice_id, action, actor_id, actor_label, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [noticeId, action, user?.id ?? null, actorLabel(user), detail, nowIso()]
  );
}

/** What the approval covers. */
export function factsOf(n) {
  const facts = [n.event_title, n.starts_at, n.ends_at, n.all_day, n.location_name, n.address, n.city, n.state, n.rain_date, n.event_status];
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

const sendAtFor = (event) => localDayAt(event, SEND_DAYS);
const cutoffFor = (n) => new Date(new Date(n.starts_at).getTime() - CUTOFF_HOURS * 3_600_000);

/* ---------------------------------------------------------------- alerts */

const approvers = () => Users.listBoard().filter((u) => Users.canApproveNotice(u));

async function alertApprovers(n, { subject, eyebrow, heading, lines }) {
  for (const u of approvers()) {
    await sendMail({
      to: u.email,
      ...boardAlertEmail({
        name: u.first_name,
        subject,
        eyebrow,
        heading,
        lines,
        buttonLabel: 'Open the notice',
        link: absoluteUrl(`/members/documents/notices/${n.id}`),
        office: Users.BOARD_ROLES[u.board_role],
      }),
    });
  }
}

const meetingLine = (n) => `${n.event_title}, ${whenOf(n).long}`;

/* ---------------------------------------------------------------- editing */

/** Edits the wording. An approved notice that is edited goes back to needing approval. */
export function edit(id, { subject, speaker, agenda, note }, user) {
  return transaction(() => {
    const n = getNotice(id);
    if (!n || !['draft', 'approved'].includes(n.status)) return { ok: false, reason: 'This notice can no longer be edited.' };
    const wasApproved = n.status === 'approved';
    run(
      `UPDATE notices SET subject = ?, speaker = ?, agenda = ?, note = ?, status = 'draft',
              approved_facts = NULL, approved_by = NULL, approved_label = NULL, approved_at = NULL, updated_at = ?
        WHERE id = ?`,
      [subject, speaker, agenda, note, nowIso(), n.id]
    );
    log(n.id, 'edited', user);
    if (wasApproved) log(n.id, 'approval_withdrawn', user, 'The wording was changed, so it needs approving again.');
    return { ok: true, withdrew: wasApproved };
  });
}

export function approve(id, user, { now = new Date() } = {}) {
  return transaction(() => {
    const n = getNotice(id);
    if (!n || n.status !== 'draft') return { ok: false, reason: 'This notice is not waiting for approval.' };
    if (!n.event_id || n.event_status !== 'published') return { ok: false, reason: 'The meeting is no longer on the calendar.' };
    if (now >= cutoffFor(n)) return { ok: false, reason: 'The meeting is too close for a notice to be useful. It will not be sent.' };
    run(
      `UPDATE notices SET status = 'approved', approved_facts = ?, approved_by = ?, approved_label = ?, approved_at = ?, updated_at = ?
        WHERE id = ?`,
      [factsOf(n), user.id, actorLabel(user), nowIso(), nowIso(), n.id]
    );
    log(n.id, 'approved', user);
    return { ok: true };
  });
}

export function cancel(id, user, reason = null) {
  const n = getNotice(id);
  if (!n || !['draft', 'approved'].includes(n.status)) return false;
  run("UPDATE notices SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), n.id]);
  log(n.id, 'cancelled', user, reason);
  return true;
}

/* --------------------------------------------------------------- building */

function mailFor(n, user) {
  return {
    to: user.email,
    headers: unsubscribeHeaders(user.id, 'meeting_notices'),
    ...meetingNoticeEmail({
      name: user.first_name,
      title: n.event_title,
      when: whenOf(n),
      where: whereOf(n),
      speaker: n.speaker,
      agenda: n.agenda,
      note: n.note,
      rainDate: rainDateText(n),
      link: absoluteUrl(`/events/${n.event_slug}`),
      directionsLink: mapUrl(n),
      unsubscribeLink: unsubscribeUrl(user.id, 'meeting_notices'),
      accountLink: absoluteUrl('/members/account'),
    }),
  };
}

/** A copy for one person to read before approving. Not recorded as a send. */
export async function sendPreview(n, user) {
  const mail = mailFor(n, user);
  await sendMail({ ...mail, subject: `[PREVIEW] ${mail.subject}` });
}

/** The same notice as markdown, for the website. */
function postMarkdown(n) {
  const items = agendaItems(n.agenda);
  const when = whenOf(n);
  return [
    ...(n.note ? [n.note, ''] : []),
    `**When:** ${when.long}`,
    ...(whereOf(n) ? ['', `**Where:** ${whereOf(n)}`] : []),
    ...(n.speaker ? ['', `**Speaker:** ${n.speaker}`] : []),
    ...(items.length ? ['', '**On the agenda**', '', ...items.map((i) => `- ${i}`)] : []),
    ...(n.rain_date ? ['', `**Rain date:** ${rainDateText(n)}`] : []),
    '',
    `[Meeting details](${absoluteUrl(`/events/${n.event_slug}`)})`,
  ].join('\n');
}

/* ------------------------------------------------------------ the tick */

/** Cancels notices whose meeting has gone, moved or been cancelled; withdraws approvals whose facts changed. */
async function reconcile(now) {
  const out = { cancelled: [], withdrawn: [] };
  const open = all(`${NOTICE_SQL} WHERE n.status IN ('draft', 'approved')`);
  for (const n of open) {
    const key = n.event_id && n.starts_at ? `event:${n.event_id}:${localDate(n.starts_at)}` : null;
    const gone = !n.event_id || n.event_status !== 'published' || n.event_kind !== 'meeting' || key !== n.occurrence_key;
    if (gone) {
      const moved = n.event_id && n.event_status === 'published' && key !== n.occurrence_key;
      cancel(n.id, null, moved ? 'The meeting moved to another date.' : 'The meeting is no longer on the calendar.');
      out.cancelled.push(n.id);
      if (n.status === 'approved') {
        await alertApprovers(n, {
          subject: `Approval withdrawn: ${n.subject}`,
          eyebrow: 'Meeting notice',
          heading: 'An approved notice was cancelled',
          lines: [
            `The notice "${n.subject}" that you approved will not be sent, because ${moved ? 'the meeting moved to another date' : 'the meeting is no longer on the calendar'}.`,
            moved ? 'A new draft will be made for the new date.' : 'Nothing was sent to members.',
          ],
        });
      }
      continue;
    }
    if (n.status === 'approved' && n.approved_facts !== factsOf(n)) {
      run(
        `UPDATE notices SET status = 'draft', approved_facts = NULL, approved_by = NULL, approved_label = NULL, approved_at = NULL, updated_at = ? WHERE id = ?`,
        [nowIso(), n.id]
      );
      log(n.id, 'approval_withdrawn', null, 'The meeting details changed after approval.');
      out.withdrawn.push(n.id);
      await alertApprovers(n, {
        subject: `Approval withdrawn: ${n.event_title}`,
        eyebrow: 'Meeting notice',
        heading: 'The meeting details changed',
        lines: [
          `${meetingLine(n)}: its title, time or place changed after you approved the notice, so the approval no longer stands.`,
          'The notice will not go out until it is approved again.',
        ],
      });
    }
  }
  return out;
}

/** Drafts a notice for each meeting that is now inside the drafting window. */
async function ensureDrafts(now) {
  const created = [];
  const events = all(
    `SELECT * FROM events WHERE kind = 'meeting' AND status = 'published' AND starts_at > ? AND starts_at <= ? ORDER BY starts_at`,
    [now.toISOString(), new Date(now.getTime() + DRAFT_DAYS * DAY).toISOString()]
  );
  for (const e of events) {
    const key = `event:${e.id}:${localDate(e.starts_at)}`;
    if (get('SELECT id FROM notices WHERE occurrence_key = ?', [key])) continue;
    const ts = nowIso();
    const info = run(
      `INSERT OR IGNORE INTO notices (event_id, occurrence_key, subject, note, status, send_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [e.id, key, `Meeting notice: ${e.title}, ${whenOf(e).short}`, e.summary || null, sendAtFor(e).toISOString(), ts, ts]
    );
    if (Number(info.changes) === 0) continue;
    const id = Number(info.lastInsertRowid);
    log(id, 'drafted', null, 'Drafted automatically from the event.');
    const n = getNotice(id);
    created.push(id);
    await alertApprovers(n, {
      subject: `Meeting notice to approve: ${e.title}`,
      eyebrow: 'Needs your approval',
      heading: 'A meeting notice is ready',
      lines: [
        `A notice for ${meetingLine(n)} has been drafted.`,
        `Read it, add the speaker and agenda, and approve it. Once approved it goes to members on ${new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'long', day: 'numeric' }).format(new Date(n.send_at) > now ? new Date(n.send_at) : now)} and is posted on the website. The President, the Vice President or the Secretary can approve it.`,
      ],
    });
  }
  return created;
}

/** Chases unapproved notices once a day once they are due, and gives up on anything past the cutoff. */
async function chase(now) {
  const out = { nudged: [], expired: [] };
  const open = all(`${NOTICE_SQL} WHERE n.status IN ('draft', 'approved') AND n.event_id IS NOT NULL`);
  for (const n of open) {
    if (now >= cutoffFor(n)) {
      cancel(n.id, null, n.status === 'approved' ? 'Approved, but the window to send it closed first.' : 'Not approved in time.');
      out.expired.push(n.id);
      await alertApprovers(n, {
        subject: `No meeting notice sent: ${n.event_title}`,
        eyebrow: 'Meeting notice',
        heading: 'No notice went out',
        lines: [
          `The notice for ${meetingLine(n)} was ${n.status === 'approved' ? 'approved too late to send' : 'not approved in time'}, and the meeting is now too close for one to be useful.`,
          'Nothing was sent to members.',
        ],
      });
      continue;
    }
    if (n.status === 'draft' && now >= new Date(n.send_at) && n.last_nudged_on !== localDate(now.toISOString())) {
      run('UPDATE notices SET last_nudged_on = ? WHERE id = ?', [localDate(now.toISOString()), n.id]);
      log(n.id, 'nudged', null, 'Approvers reminded.');
      out.nudged.push(n.id);
      await alertApprovers(n, {
        subject: `Still waiting for approval: ${n.event_title}`,
        eyebrow: 'Needs your approval',
        heading: 'This notice should have gone out',
        lines: [
          `The notice for ${meetingLine(n)} is still waiting for approval. It was due to go to members already, and it will not be sent until the President, Vice President or Secretary approves it.`,
        ],
      });
    }
  }
  return out;
}

/** Sends every approved notice that has come due. */
async function sendDue(now) {
  const sent = [];
  const due = all(`${NOTICE_SQL} WHERE n.status = 'approved' AND n.send_at <= ?`, [now.toISOString()]);
  for (const n of due) {
    // Claim it first, so a second tick or process cannot send it again.
    const claim = run("UPDATE notices SET status = 'sending', updated_at = ? WHERE id = ? AND status = 'approved'", [nowIso(), n.id]);
    if (Number(claim.changes) === 0) continue;

    const recipients = Users.mailRecipients('mail_meeting_notices');
    for (const user of recipients) await sendMail(mailFor(n, user));

    // The website post. A failure here must not undo an email that has gone out.
    let postId = null;
    try {
      postId = Posts.createPost({
        title: `${n.event_title}, ${whenOf(n).short}`,
        bodyMd: postMarkdown(n),
        authorId: n.approved_by,
        status: 'published',
        visibility: 'public',
        tags: ['meeting-notice'],
      });
    } catch (err) {
      console.error('[notices] could not post to the website:', err.message);
    }
    run("UPDATE notices SET status = 'sent', sent_at = ?, recipients = ?, post_id = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      recipients.length,
      postId?.id ?? postId ?? null,
      nowIso(),
      n.id,
    ]);
    log(n.id, 'sent', null, `Emailed to ${recipients.length} member${recipients.length === 1 ? '' : 's'}${postId ? ' and posted on the website.' : '; the website post failed.'}`);
    sent.push({ id: n.id, recipients: recipients.length });
    console.log(`[notices] sent "${n.event_title}" notice to ${recipients.length} member${recipients.length === 1 ? '' : 's'}`);
  }
  return sent;
}

/** One pass: tidy up, draft, chase, send. `now` is a parameter so tests can step through time. */
export async function runNotices({ now = new Date() } = {}) {
  const tidy = await reconcile(now);
  const drafted = await ensureDrafts(now);
  const chased = await chase(now);
  const sent = await sendDue(now);
  return { ...tidy, drafted, ...chased, sent };
}
