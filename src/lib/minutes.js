import { all, get, run, nowIso } from '../db/index.js';
import * as Users from '../models/users.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { sendMail, boardAlertEmail, minutesPublishedEmail } from './mailer.js';
import { unsubscribeUrl, unsubscribeHeaders } from './unsubscribe.js';
import { whenOf, localDayAt, localDate } from './event-format.js';
import config from '../config.js';

/**
 * Following up on a meeting's minutes.
 *
 * Only meetings an editor has ticked "Minutes are expected" on are followed.
 * For each one, once the meeting is over:
 *
 *   the next morning   it shows on the Secretary's dashboard
 *   3 days after       the Secretary is emailed, and again every 2 days
 *   10 days after      the President and Vice President are told, once
 *
 * The follow-up stops as soon as a minutes document exists for that meeting
 * (linked to it, or dated the day of the meeting), or an officer says no
 * minutes are needed. With no Secretary on the site the President is the one
 * reminded. Nothing here ever emails members: that is a separate step when
 * approved minutes are published.
 */
const DAY = 86_400_000;
const NUDGE_AFTER_DAYS = 3;
const NUDGE_EVERY_MS = 47 * 3_600_000; // a little under two days, so a 9:00 pass every other morning always lands
const ESCALATE_AFTER_DAYS = 10;
const GIVE_UP_AFTER_DAYS = 30;
const HORIZON_DAYS = 120;

export const STATE_LABELS = {
  missing: 'Minutes needed',
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  published: 'Published',
  not_needed: 'Not needed',
};

/* ----------------------------------------------------------------- lookup */

function minutesDoc(event) {
  return get(
    `SELECT * FROM documents
      WHERE kind = 'minutes' AND (event_id = ? OR (event_id IS NULL AND meeting_date = ?))
      ORDER BY (event_id IS NOT NULL) DESC, id DESC LIMIT 1`,
    [event.id, localDate(event.starts_at)]
  );
}

/** Every meeting that expects minutes and has happened, newest first, with where its minutes stand. */
export function tasks({ now = new Date() } = {}) {
  const events = all(
    `SELECT * FROM events
      WHERE kind = 'meeting' AND minutes_expected = 1 AND status = 'published' AND starts_at < ? AND starts_at > ?
      ORDER BY starts_at DESC`,
    [now.toISOString(), new Date(now.getTime() - HORIZON_DAYS * DAY).toISOString()]
  );
  return events.map((event) => {
    const record = get('SELECT * FROM minutes_tasks WHERE event_id = ?', [event.id]) ?? null;
    const doc = minutesDoc(event);
    let state = 'missing';
    if (record?.dismissed_at) state = 'not_needed';
    else if (doc) state = doc.published_version_id ? 'published' : { draft: 'draft', changes_requested: 'draft', in_review: 'in_review', approved: 'approved' }[doc.status];
    return {
      event,
      doc,
      record,
      state,
      showFrom: localDayAt(event, -1, 0),
      nudgeFrom: localDayAt(event, -NUDGE_AFTER_DAYS),
      escalateFrom: localDayAt(event, -ESCALATE_AFTER_DAYS),
      giveUpAt: localDayAt(event, -GIVE_UP_AFTER_DAYS),
    };
  });
}

/** Meetings from the last couple of months, for the "which meeting?" choice on the add-a-document form. */
export function recentMeetings({ now = new Date() } = {}) {
  return all(
    `SELECT id, title, starts_at, minutes_expected FROM events
      WHERE kind = 'meeting' AND status = 'published' AND starts_at <= ? AND starts_at > ?
      ORDER BY starts_at DESC`,
    [new Date(now.getTime() + 7 * DAY).toISOString(), new Date(now.getTime() - 90 * DAY).toISOString()]
  );
}

/** Who is reminded: the Secretary, or the President when there is none. */
export function owners() {
  const board = Users.listBoard();
  const secretary = board.filter((u) => u.board_role === 'secretary');
  return secretary.length ? secretary : board.filter((u) => u.board_role === 'president');
}

export const isOwner = (user) => owners().some((u) => u.id === user?.id);

/* ---------------------------------------------------------------- actions */

export function markNotNeeded(eventId, user) {
  const e = get("SELECT id FROM events WHERE id = ? AND kind = 'meeting'", [Number(eventId)]);
  if (!e) return false;
  const label = `${Users.displayName(user)}${user.board_role ? ` (${Users.BOARD_ROLES[user.board_role]})` : ''}`;
  run(
    `INSERT INTO minutes_tasks (event_id, dismissed_by, dismissed_label, dismissed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET dismissed_by = excluded.dismissed_by, dismissed_label = excluded.dismissed_label, dismissed_at = excluded.dismissed_at`,
    [e.id, user.id, label, nowIso()]
  );
  return true;
}

/** Undoes "not needed". */
export function reopen(eventId) {
  run('UPDATE minutes_tasks SET dismissed_by = NULL, dismissed_label = NULL, dismissed_at = NULL WHERE event_id = ?', [Number(eventId)]);
}

const addMinutesLink = (event) => absoluteUrl(`/members/documents/board/new?kind=minutes&event=${event.id}`);

/** One pass: remind, and escalate. `now` is a parameter so tests can step through time. */
export async function runMinutes({ now = new Date() } = {}) {
  const out = { nudged: [], escalated: [] };
  for (const t of tasks({ now })) {
    if (t.state !== 'missing') continue;
    const e = t.event;

    if (now >= t.nudgeFrom && now < t.giveUpAt) {
      const last = t.record?.last_nudged_at ? new Date(t.record.last_nudged_at) : null;
      if (!last || now.getTime() - last.getTime() >= NUDGE_EVERY_MS) {
        for (const u of owners()) {
          const days = Math.max(1, Math.round((now.getTime() - new Date(e.starts_at).getTime()) / DAY));
          await sendMail({
            to: u.email,
            ...boardAlertEmail({
              name: u.first_name,
              subject: `Minutes needed: ${e.title}`,
              eyebrow: 'Minutes needed',
              heading: `Minutes for ${e.title}`,
              lines: [
                `The meeting was ${whenOf(e).long}, ${days} day${days === 1 ? '' : 's'} ago, and no minutes have been added yet.`,
                'Add them as a PDF or Word file, then send them to the President or Vice President for review. If no minutes are needed for this meeting, you can say so from your dashboard.',
              ],
              buttonLabel: 'Add the minutes',
              link: addMinutesLink(e),
              office: Users.BOARD_ROLES[u.board_role],
            }),
          });
        }
        run(
          `INSERT INTO minutes_tasks (event_id, last_nudged_at, nudges) VALUES (?, ?, 1)
           ON CONFLICT(event_id) DO UPDATE SET last_nudged_at = excluded.last_nudged_at, nudges = nudges + 1`,
          [e.id, now.toISOString()]
        );
        out.nudged.push(e.id);
      }
    }

    if (now >= t.escalateFrom && !t.record?.escalated_at) {
      const approvers = Users.listBoard().filter((u) => Users.canApprove(u));
      for (const u of approvers) {
        await sendMail({
          to: u.email,
          ...boardAlertEmail({
            name: u.first_name,
            subject: `Minutes overdue: ${e.title}`,
            eyebrow: 'Minutes overdue',
            heading: `No minutes yet for ${e.title}`,
            lines: [
              `The meeting was ${whenOf(e).long}, ${ESCALATE_AFTER_DAYS} days ago, and no minutes have been added. The Secretary has been reminded.`,
              'You are being told once. You can see what is outstanding on the board documents page.',
            ],
            buttonLabel: 'See what is outstanding',
            link: absoluteUrl('/members/documents/board'),
            office: Users.BOARD_ROLES[u.board_role],
          }),
        });
      }
      run(
        `INSERT INTO minutes_tasks (event_id, escalated_at) VALUES (?, ?)
         ON CONFLICT(event_id) DO UPDATE SET escalated_at = excluded.escalated_at`,
        [e.id, now.toISOString()]
      );
      out.escalated.push(e.id);
    }
  }
  return out;
}

/* --------------------------------------------- telling members it is up */

/**
 * Emails members a link to newly published minutes. A link only, never the file:
 * they have to be signed in to read them. Goes to everyone who has not turned
 * meeting notices off.
 */
export async function emailPublished(doc) {
  const recipients = Users.mailRecipients('mail_meeting_notices');
  for (const user of recipients) {
    await sendMail({
      to: user.email,
      headers: unsubscribeHeaders(user.id, 'meeting_notices'),
      ...minutesPublishedEmail({
        name: user.first_name,
        title: doc.title,
        link: absoluteUrl(`/members/documents/${doc.id}`),
        unsubscribeLink: unsubscribeUrl(user.id, 'meeting_notices'),
        accountLink: absoluteUrl('/members/account'),
      }),
    });
  }
  return recipients.length;
}

export const reminderHour = config.scheduler.reminderHour;
