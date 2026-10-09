import crypto from 'node:crypto';
import helmet from 'helmet';
import config from '../config.js';

/**
 * Per-request CSP nonce.
 *
 * The Content-Security-Policy below allows no inline script at all unless it
 * carries this nonce, which is unguessable and changes every response. That
 * turns most would-be XSS from "attacker runs JS" into "attacker inserts inert
 * text", even if a sanitiser somewhere is bypassed.
 */
export function cspNonce(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        // Nonce-based: no 'unsafe-inline', no wildcard hosts.
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        scriptSrcAttr: ["'none'"], // blocks onclick="..." entirely
        // Inline styles are still needed for a couple of computed values
        // (carousel transforms, map pin offsets); everything else is in the
        // stylesheet. No remote style hosts.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // 'blob:' is for the client-side upload preview: site.js turns the
        // chosen file into an object URL so you can see what you picked
        // before submitting. Without it the browser silently refuses to show
        // the thumbnail. Neither blob: nor data: images can execute.
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"], // clickjacking
        frameSrc: ["'none'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: config.isProd
      ? { maxAge: 31536000, includeSubDomains: true, preload: false }
      : false,
    noSniff: true,
    frameguard: { action: 'deny' },
    xPoweredBy: false,
    dnsPrefetchControl: { allow: false },
  });
}

/** Headers helmet does not set for us. */
export function extraHeaders(req, res, next) {
  res.setHeader(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(self), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()'
  );
  // Members-only responses must never sit in a shared cache.
  if (req.path.startsWith('/members')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

/**
 * Rejects state-changing requests whose Origin/Referer is not this site.
 * Belt-and-braces alongside the CSRF token: it stops a forged POST before any
 * handler runs, and it costs nothing.
 */
export function verifyOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.get('origin') || req.get('referer');
  if (!origin) {
    // Some privacy tools strip both headers; the CSRF token still applies.
    return next();
  }

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    const err = new Error('Malformed Origin header.');
    err.status = 403;
    return next(err);
  }

  // Two ways to be legitimate:
  //  - the origin's host matches the host this request arrived on, which is
  //    the ordinary case when the app is exposed directly; or
  //  - it is a public origin the deployment has declared (BASE_URL /
  //    ALLOWED_ORIGINS). Behind a reverse proxy the two never match, because
  //    the browser sees the public name and the app sees an internal one.
  const sameHost = parsed.host === req.get('host');
  const declared = config.allowedOrigins.has(parsed.origin);

  if (!sameHost && !declared) {
    const err = new Error('Cross-origin form submissions are not accepted.');
    err.status = 403;
    return next(err);
  }
  return next();
}

/** Caps request body size before Express parses it. */
export const bodyLimits = { json: '64kb', urlencoded: '256kb' };
