import { get, run, nowIso } from '../db/index.js';

/**
 * Member-to-member messages sent from the directory.
 *
 * Only who wrote to whom, and when, is kept -- enough to rate-limit a sender.
 * The message itself goes out by email and is not stored here.
 */

/**
 * Per sender, counted in the database rather than by IP so the limits hold
 * across restarts, networks and the relaxed development limiter. Generous for
 * someone looking for a ride to Oshkosh; tight for someone working down the
 * whole directory.
 */
export const LIMITS = {
  perHour: 5,
  perDay: 20,
  // The same person, in 24 hours. Room for "sorry, forgot to say", not for pestering.
  perRecipientPerDay: 3,
};

/**
 * Whether `sender` may write to `recipient` through the site. The link is
 * offered only where it is needed: to an active member who hides their email
 * and has not switched messages off. Someone who shares their email is
 * reached directly.
 */
export function canMessage(sender, recipient) {
  return Boolean(
    sender &&
      recipient &&
      Number(sender.id) !== Number(recipient.id) &&
      recipient.status === 'active' &&
      !recipient.share_email &&
      recipient.accept_messages
  );
}

const since = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 60 * 60 * 1000;

/** Null when the sender is within their limits, otherwise the reason to show them. */
export function limitReason(senderId, recipientId) {
  const count = (sql, params) => get(sql, params).n;
  const lastDay = since(24 * HOUR);
  if (
    count(
      'SELECT COUNT(*) AS n FROM member_messages WHERE sender_id = ? AND recipient_id = ? AND created_at > ?',
      [senderId, recipientId, lastDay]
    ) >= LIMITS.perRecipientPerDay
  ) {
    return 'You have already sent this member several messages today. Give them a chance to reply.';
  }
  if (
    count('SELECT COUNT(*) AS n FROM member_messages WHERE sender_id = ? AND created_at > ?', [senderId, since(HOUR)]) >=
    LIMITS.perHour
  ) {
    return 'You have sent several messages in the last hour. Please wait a while before sending more.';
  }
  if (
    count('SELECT COUNT(*) AS n FROM member_messages WHERE sender_id = ? AND created_at > ?', [senderId, lastDay]) >=
    LIMITS.perDay
  ) {
    return 'You have reached the limit of messages for today. Please try again tomorrow.';
  }
  return null;
}

export function recordMessage(senderId, recipientId) {
  run('INSERT INTO member_messages (sender_id, recipient_id, created_at) VALUES (?, ?, ?)', [
    senderId,
    recipientId,
    nowIso(),
  ]);
}
