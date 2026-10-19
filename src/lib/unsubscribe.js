import crypto from 'node:crypto';
import config from '../config.js';
import { safeEqual } from './tokens.js';
import { absoluteUrl } from '../middleware/base-path.js';

/**
 * Unsubscribe links.
 *
 * Every optional email carries a link that switches off that one category for
 * that one person, with no login. The link is stateless: it names the member
 * and the category and is signed with a key derived from the site's secret, so
 * it cannot be forged or pointed at somebody else, and it keeps working for as
 * long as the secret does (an unsubscribe link should not expire).
 *
 * The only thing a valid link can do is turn email off, or back on again, for
 * the person it names. That is why the routes behind it accept a POST with no
 * session and no CSRF token -- which is also what a mail client's one-click
 * unsubscribe button sends (RFC 8058).
 */

/** URL code -> users column. */
export const CATEGORIES = {
  newsletter: 'mail_newsletter',
  meeting_notices: 'mail_meeting_notices',
  reminders: 'mail_reminders',
};

function key() {
  return crypto.createHmac('sha256', config.secrets.session).update('eaa1699:unsubscribe').digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url').slice(0, 24);
}

export function makeToken(userId, category) {
  if (!CATEGORIES[category]) throw new Error(`Unknown mail category: ${category}`);
  const payload = Buffer.from(`${Number(userId)}.${category}`).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns `{ userId, category, column }`, or null for anything that is not a genuine token. */
export function readToken(token) {
  const [payload, sig, extra] = String(token ?? '').split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, sign(payload))) return null;
  const [id, category] = Buffer.from(payload, 'base64url').toString().split('.');
  const userId = Number(id);
  if (!Number.isInteger(userId) || !CATEGORIES[category]) return null;
  return { userId, category, column: CATEGORIES[category] };
}

export function unsubscribeUrl(userId, category) {
  return absoluteUrl(`/unsubscribe/${makeToken(userId, category)}`);
}

/** Headers that give mail clients their own Unsubscribe button. */
export function unsubscribeHeaders(userId, category) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(userId, category)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
