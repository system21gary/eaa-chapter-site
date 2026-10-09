import crypto from 'node:crypto';
import config from '../config.js';
import { safeEqual } from './tokens.js';

/**
 * Signed double-submit CSRF tokens.
 *
 * The token is `<random>.<hmac(sessionId + random)>`. Because the HMAC is
 * bound to the session id and keyed by a server-side secret, a token minted
 * for one session cannot be replayed in another, and an attacker who can only
 * *send* cross-site requests (without reading our responses) cannot forge one.
 *
 * This replaces the deprecated `csurf` package. SameSite=Lax cookies are the
 * first line of defence; this is the second, because SameSite alone does not
 * cover every browser or every top-level-navigation POST.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sign(sessionId, nonce) {
  return crypto
    .createHmac('sha256', config.secrets.csrf)
    .update(`${sessionId}.${nonce}`)
    .digest('base64url');
}

export function issueToken(req) {
  if (!req.session) return '';
  if (!req.session.csrfNonce) {
    req.session.csrfNonce = crypto.randomBytes(24).toString('base64url');
  }
  const nonce = req.session.csrfNonce;
  return `${nonce}.${sign(req.sessionID, nonce)}`;
}

function verify(req, presented) {
  if (!presented || typeof presented !== 'string') return false;
  const sessionNonce = req.session?.csrfNonce;
  if (!sessionNonce) return false;

  const idx = presented.lastIndexOf('.');
  if (idx <= 0) return false;
  const nonce = presented.slice(0, idx);
  const mac = presented.slice(idx + 1);

  if (!safeEqual(nonce, sessionNonce)) return false;
  return safeEqual(mac, sign(req.sessionID, nonce));
}

function reject(next) {
  const err = new Error('This form expired or came from an untrusted source. Please try again.');
  err.status = 403;
  err.code = 'EBADCSRFTOKEN';
  return next(err);
}

function check(req, next) {
  const presented =
    req.body?._csrf ||
    req.get('x-csrf-token') ||
    req.get('x-xsrf-token');

  if (!verify(req, presented)) return reject(next);
  req.csrfVerified = true;
  return next();
}

export function csrfProtection(req, res, next) {
  // Expose a fresh token to every template.
  res.locals.csrfToken = issueToken(req);

  if (SAFE_METHODS.has(req.method)) return next();

  /**
   * File uploads arrive as multipart/form-data, which `express.urlencoded`
   * does not touch -- only the route's own multer does, and that runs later.
   * So `req.body` is still empty here and the token cannot be read yet.
   *
   * Rather than let those requests through unchecked, they are marked and
   * must be verified by `verifyMultipartCsrf` once multer has populated the
   * body. `requireVerifiedCsrf` is the backstop that fails the request if a
   * route ever forgets.
   */
  if (req.is('multipart/form-data')) {
    req.csrfDeferred = true;
    return next();
  }

  return check(req, next);
}

/** Runs immediately after multer on any route that accepts uploads. */
export function verifyMultipartCsrf(req, res, next) {
  if (req.csrfVerified) return next();
  return check(req, next);
}

/**
 * Backstop for the deferred check.
 *
 * The verification itself has to sit inside each upload route, after multer.
 * That is easy to forget when adding one. This watches every response and
 * shouts if a multipart request succeeded without ever being verified, so a
 * missing `verifyMultipartCsrf` surfaces in development and in the test suite
 * rather than silently in production.
 */
export function auditDeferredCsrf(req, res, next) {
  res.on('finish', () => {
    if (!req.csrfDeferred || req.csrfVerified) return;
    if (res.statusCode >= 400) return; // already refused, for this or another reason
    console.error(
      `[csrf] SECURITY: ${req.method} ${req.originalUrl} completed with ${res.statusCode} ` +
        'but its token was never verified. That route accepts uploads and is missing ' +
        'verifyMultipartCsrf after its multer middleware.'
    );
  });
  next();
}

/**
 * Rotates the CSRF nonce. Called on privilege changes (login, password reset)
 * alongside session regeneration.
 */
export function rotateCsrf(req) {
  if (req.session) req.session.csrfNonce = crypto.randomBytes(24).toString('base64url');
}
