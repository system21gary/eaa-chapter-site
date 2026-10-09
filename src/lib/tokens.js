import crypto from 'node:crypto';

/**
 * Single-use secrets (password resets, invites).
 *
 * The raw token is generated once, handed to the recipient, and immediately
 * forgotten by the server. Only its SHA-256 is persisted, and lookups hash the
 * incoming token before querying -- so the stored value is useless to anyone
 * who reads the database, and the lookup itself cannot be turned into a
 * timing oracle (it is an indexed equality match on a uniform digest).
 */
export function createToken(bytes = 32) {
  const raw = crypto.randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/** Constant-time string compare that tolerates length differences. */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(len);
  const padB = Buffer.alloc(len);
  bufA.copy(padA);
  bufB.copy(padB);
  return crypto.timingSafeEqual(padA, padB) && bufA.length === bufB.length;
}

/**
 * IP addresses are personal data under GDPR-style regimes and we only ever
 * need them for abuse correlation, so we keep a keyed digest rather than the
 * address itself.
 */
export function hashIp(ip, key) {
  if (!ip) return null;
  return crypto.createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 32);
}

export function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function daysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function isExpired(isoString) {
  return !isoString || new Date(isoString).getTime() <= Date.now();
}
