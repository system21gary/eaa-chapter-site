import { all, get, run, nowIso } from '../db/index.js';
import * as Users from '../models/users.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { sendMail, eventUpdateEmail } from './mailer.js';
import { unsubscribeUrl, unsubscribeHeaders } from './unsubscribe.js';
import { whenOf, whereOf } from './event-format.js';
import { mapUrl } from '../views/filters.js';

/**
 * Telling members about a change to an event: a new time or place, or a
 * cancellation. An editor writes the message; the site wraps it in the event's
 * details and sends it to everyone who has not turned reminders off. (These
 * are part of the same preference as reminders: a member who has opted out of
 * event email is not sent these either.)
 *
 * Recorded before anything is queued, with a guard against sending the same
 * words twice by a double click.
 */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;

function mailFor(event, { kind, message }, user) {
  return {
    to: user.email,
    headers: unsubscribeHeaders(user.id, 'reminders'),
    ...eventUpdateEmail({
      name: user.first_name,
      title: event.title,
      cancelled: kind === 'cancelled',
      message,
      when: whenOf(event),
      where: whereOf(event),
      link: absoluteUrl(`/events/${event.slug}`),
      directionsLink: mapUrl(event),
      unsubscribeLink: unsubscribeUrl(user.id, 'reminders'),
      accountLink: absoluteUrl('/members/account'),
    }),
  };
}

export const audience = () => Users.mailRecipients('mail_reminders').length;

export function listUpdates(eventId) {
  return all('SELECT * FROM event_updates WHERE event_id = ? ORDER BY id DESC', [Number(eventId)]);
}

/** A copy to the editor alone, to read before sending. Not recorded. */
export async function sendPreview(event, update, user) {
  const mail = mailFor(event, update, user);
  await sendMail({ ...mail, subject: `[PREVIEW] ${mail.subject}` });
}

export async function sendUpdate(event, update, user) {
  const repeat = get(
    'SELECT created_at FROM event_updates WHERE event_id = ? AND message = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    [event.id, update.message, update.kind]
  );
  if (repeat && Date.now() - new Date(repeat.created_at).getTime() < REPEAT_WINDOW_MS) {
    return { ok: false, reason: 'That exact message was just sent. Change the wording if you mean to send another.' };
  }
  const label = `${Users.displayName(user)}${user.board_role ? ` (${Users.BOARD_ROLES[user.board_role]})` : ''}`;
  const info = run(
    `INSERT INTO event_updates (event_id, event_title, kind, message, sent_by, sent_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [event.id, event.title, update.kind, update.message, user.id, label, nowIso()]
  );
  const recipients = Users.mailRecipients('mail_reminders');
  for (const member of recipients) await sendMail(mailFor(event, update, member));
  run('UPDATE event_updates SET recipients = ? WHERE id = ?', [recipients.length, Number(info.lastInsertRowid)]);
  return { ok: true, recipients: recipients.length };
}
