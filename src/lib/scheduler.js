import config from '../config.js';
import { all, get, run, nowIso } from '../db/index.js';
import * as Users from '../models/users.js';
import { toLocalDateInput } from './localtime.js';
import { whenOf, whereOf, localDayAt, effectiveReminders, KIND_LABELS, rainDateText } from './event-format.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { sendMail, eventReminderEmail } from './mailer.js';
import { unsubscribeUrl, unsubscribeHeaders } from './unsubscribe.js';
import { mapUrl } from '../views/filters.js';
import { runNotices } from './notices.js';

/**
 * Automatic email.
 *
 * Today there is one rule: before a chapter event, members who have not opted
 * out of reminders get a short note -- the day before, and for the bigger
 * events (fly-ins, Young Eagles days) a week before as well. Which events, and
 * which reminders, is the event's own setting, with a default for each type
 * (see event-format.js). Dates come from the events calendar, so moving an event
 * moves its reminders.
 *
 * How it stays safe:
 *  - Each send is recorded in `scheduled_sends` BEFORE anything is queued, under
 *    a unique (rule, occurrence) key, so a restart or a second process cannot
 *    send it twice.
 *  - A send that is more than CATCH_UP_HOURS late is skipped, not sent: a
 *    reminder that arrives the evening of the meeting is worse than none.
 *  - It never sends once the event has started.
 *  - It can be paused from the Scheduled emails page, or switched off with
 *    SCHEDULER=0.
 *  - Recipients come from Users.mailRecipients(), the one place opt-outs and
 *    suspensions are honoured.
 */
export const RULES = {
  event_reminder: { label: 'Event reminder', pref: 'mail_reminders', category: 'reminders' },
};

/** How far ahead each reminder goes, in calendar days. */
export const LEADS = {
  week: { days: 7, label: 'a week before' },
  day: { days: 1, label: 'the day before' },
};

const CATCH_UP_HOURS = 18;
const HORIZON_DAYS = 45;

/* ------------------------------------------------------------------ pause */

export function isPaused() {
  return get("SELECT value FROM app_state WHERE key = 'scheduler_paused'")?.value === '1';
}

export function setPaused(paused) {
  run(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('scheduler_paused', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [paused ? '1' : '0', nowIso()]
  );
}

/* --------------------------------------------------------------- planning */

/** REMINDER_HOUR (9:00) chapter time, `lead` days before the event's date. */
export function reminderDueAt(event, lead = 'day') {
  return localDayAt(event, LEADS[lead].days);
}

/**
 * What is going to be sent, and what has been dealt with. The occurrence key
 * includes the event's local date and the lead, so an event that moves gets
 * fresh reminders for its new date.
 */
export function plan({ now = new Date(), days = HORIZON_DAYS } = {}) {
  const events = all(
    `SELECT id, slug, title, summary, starts_at, ends_at, all_day, rain_date, location_name, address, city, state,
            latitude, longitude, kind, reminders
       FROM events
      WHERE status = 'published' AND starts_at > ? AND starts_at <= ?
      ORDER BY starts_at`,
    [now.toISOString(), new Date(now.getTime() + days * 86_400_000).toISOString()]
  );
  const items = [];
  for (const event of events) {
    const mode = effectiveReminders(event);
    if (mode === 'off') continue;
    for (const lead of mode === 'week_and_day' ? ['week', 'day'] : ['day']) {
      const key = `event:${event.id}:${toLocalDateInput(event.starts_at)}:${lead}`;
      const due = reminderDueAt(event, lead);
      const record = get('SELECT * FROM scheduled_sends WHERE rule = ? AND occurrence_key = ?', ['event_reminder', key]);
      const state = record ? record.status : due <= now ? 'due' : 'scheduled';
      items.push({ rule: 'event_reminder', lead, key, event, dueAt: due.toISOString(), state, record });
    }
  }
  return items;
}

/** Most recent first. */
export function recentSends(limit = 15) {
  return all(
    `SELECT s.*, e.title AS event_title FROM scheduled_sends s LEFT JOIN events e ON e.id = s.event_id
      ORDER BY s.id DESC LIMIT ?`,
    [limit]
  );
}

/** How many members a rule would reach right now. */
export function audience(rule = 'event_reminder') {
  return Users.mailRecipients(RULES[rule].pref).length;
}

/* ---------------------------------------------------------------- sending */

function reminderFor(event, user, lead = 'day') {
  return {
    to: user.email,
    headers: unsubscribeHeaders(user.id, 'reminders'),
    ...eventReminderEmail({
      name: user.first_name,
      title: event.title,
      kindLabel: KIND_LABELS[event.kind] ?? 'Event',
      lead,
      when: whenOf(event),
      where: whereOf(event),
      summary: event.summary,
      rainDate: rainDateText(event),
      link: absoluteUrl(`/events/${event.slug}`),
      directionsLink: mapUrl(event),
      unsubscribeLink: unsubscribeUrl(user.id, 'reminders'),
      accountLink: absoluteUrl('/members/account'),
    }),
  };
}

/** A copy for one person, to check what members will receive. Not recorded as a send. */
export async function sendTest(event, user, lead = 'day') {
  const mail = reminderFor(event, user, lead);
  await sendMail({ ...mail, subject: `[TEST] ${mail.subject}` });
}

async function sendReminder(event, lead) {
  // Members who have turned reminders off, and suspended members, are left out here.
  const recipients = Users.mailRecipients(RULES.event_reminder.pref);
  for (const user of recipients) await sendMail(reminderFor(event, user, lead));
  return recipients.length;
}

/**
 * Sends whatever has come due. Returns what it did, for the log and for tests.
 * `now` is a parameter so tests can step through time.
 */
export async function tick({ now = new Date() } = {}) {
  const done = { sent: [], skipped: [], notices: null };
  if (isPaused()) return { ...done, paused: true };

  for (const item of plan({ now })) {
    if (item.state !== 'due') continue;
    const lateBy = (now.getTime() - new Date(item.dueAt).getTime()) / 3_600_000;
    const claim = run(
      `INSERT OR IGNORE INTO scheduled_sends (rule, occurrence_key, event_id, due_at, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [item.rule, item.key, item.event.id, item.dueAt, lateBy > CATCH_UP_HOURS ? 'skipped' : 'sending', lateBy > CATCH_UP_HOURS ? 'too late to be useful' : null, nowIso()]
    );
    if (Number(claim.changes) === 0) continue; // someone else got there first
    if (lateBy > CATCH_UP_HOURS) {
      done.skipped.push(item.key);
      continue;
    }
    const count = await sendReminder(item.event, item.lead);
    run("UPDATE scheduled_sends SET status = 'sent', recipients = ?, sent_at = ? WHERE rule = ? AND occurrence_key = ?", [
      count,
      nowIso(),
      item.rule,
      item.key,
    ]);
    done.sent.push({ key: item.key, recipients: count });
    console.log(`[scheduler] sent "${item.event.title}" (${LEADS[item.lead].label}) reminder to ${count} member${count === 1 ? '' : 's'}`);
  }
  done.notices = await runNotices({ now });
  return done;
}

/** An officer skipping a send ahead of time. Only for something still in the plan. */
export function skip(key, user) {
  const item = plan().find((p) => p.key === key);
  if (!item || item.record) return false;
  run(
    `INSERT OR IGNORE INTO scheduled_sends (rule, occurrence_key, event_id, due_at, status, note, created_at)
     VALUES (?, ?, ?, ?, 'skipped', ?, ?)`,
    [item.rule, item.key, item.event.id, item.dueAt, `skipped by ${Users.displayName(user)}`, nowIso()]
  );
  return true;
}

/** Undoes an officer's skip (not an automatic one). */
export function unskip(key) {
  const info = run(
    "DELETE FROM scheduled_sends WHERE occurrence_key = ? AND status = 'skipped' AND note LIKE 'skipped by %'",
    [key]
  );
  return Number(info.changes) > 0;
}

/* ------------------------------------------------------------------ timer */

let timer = null;
let first = null;

export function startScheduler() {
  if (!config.scheduler.enabled || timer) return false;
  const run_ = () => tick().catch((err) => console.error('[scheduler] tick failed:', err.message));
  first = setTimeout(run_, 60 * 1000);
  first.unref();
  timer = setInterval(run_, 5 * 60 * 1000);
  timer.unref();
  return true;
}

export function stopScheduler() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  timer = null;
  first = null;
}
