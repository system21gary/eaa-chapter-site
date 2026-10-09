import rateLimit from 'express-rate-limit';
import config from '../config.js';

/**
 * Normalises a client address into a rate-limit key.
 *
 * IPv6 is collapsed to its /64 prefix: a single subscriber is routinely handed
 * a whole /64, so keying on the full address would let one attacker walk
 * through billions of "distinct" clients and never hit a limit.
 */
function ipKey(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const bare = ip.replace(/^::ffff:/, '');
  if (!bare.includes(':')) return bare;
  return bare.split(':').slice(0, 4).join(':');
}

/**
 * Rate limits.
 *
 * Tight on the endpoints an attacker actually hammers -- login, password
 * reset, contact form, uploads -- and loose everywhere else so a family
 * sharing one NAT address can still browse the site normally.
 */
function make({ windowMs, max, message, keyGenerator = ipKey }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // In development a single machine hits every limit while you click
    // around, so limits are relaxed rather than removed.
    skip: () => config.isDev && process.env.ENFORCE_LIMITS !== '1',
    keyGenerator,
    handler: (req, res, next) => {
      const err = new Error(message);
      err.status = 429;
      next(err);
    },
  });
}

export const generalLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: 'You are making requests very quickly. Please slow down and try again shortly.',
});

/**
 * Keyed on IP *and* the submitted email, so one attacker cannot lock every
 * member out by spraying their addresses from a single address, and a
 * distributed attack still trips the per-account lockout in the DB.
 */
export const loginLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
  keyGenerator: (req) =>
    `${ipKey(req)}|${String(req.body?.email ?? '').toLowerCase().slice(0, 120)}`,
});

export const passwordResetLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many password reset requests. Please wait an hour and try again.',
});

export const contactLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: 'You have sent several messages already. Please give us a chance to reply first.',
});

export const uploadLimiter = make({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: 'Upload limit reached for this hour.',
});

export const writeLimiter = make({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many changes submitted at once. Please pause for a few minutes.',
});
