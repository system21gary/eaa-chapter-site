import 'dotenv/config';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Project root (the directory holding package.json), resolved from src/.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(rootDir, 'src');

// Everything the app writes lives here; see config.dataDir below.
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

/**
 * Secrets must be supplied in production. In development we generate an
 * ephemeral one so `npm run dev` works on a fresh clone -- sessions simply
 * do not survive a restart, which is the safe failure mode.
 */
function secret(name) {
  const value = process.env[name];
  if (value && value.length >= 32) return value;
  if (isProd) {
    throw new Error(
      `${name} must be set to a random string of at least 32 characters in production. ` +
        'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }
  if (value) {
    console.warn(`[config] ${name} is shorter than 32 chars; using an ephemeral dev secret instead.`);
  }
  return crypto.randomBytes(48).toString('base64url');
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function int(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) ? raw : fallback;
}

/**
 * Outbound mail.
 *
 * Two transports. 'outbox' (the default) queues to the database and delivers
 * nothing, which is how the site bootstraps: an admin reads the first
 * invitation link straight out of the queue. 'smtp' delivers for real.
 *
 * Note for anyone reaching for IMAP credentials: IMAP reads a mailbox, it
 * cannot send. Sending is SMTP. Mail providers offer both, usually on the same
 * username and password, so the account is almost certainly the right one --
 * it is the host and port that differ.
 */
function mailConfig() {
  const transport = process.env.MAIL_TRANSPORT || 'outbox';
  if (!['outbox', 'smtp'].includes(transport)) {
    throw new Error(`MAIL_TRANSPORT must be 'outbox' or 'smtp', not '${transport}'.`);
  }

  const port = int('SMTP_PORT', 587);
  const smtp = {
    host: (process.env.SMTP_HOST || '').trim(),
    port,
    // 465 is implicit TLS from the first byte; 587 opens in the clear and
    // upgrades with STARTTLS. Getting this pair wrong is the single most
    // common cause of a connection that hangs and then times out.
    secure: bool('SMTP_SECURE', port === 465),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    requireTls: bool('SMTP_REQUIRE_TLS', true),
    // Escape hatch for an internal relay with a self-signed certificate.
    // Never for a public provider: it disables the check that the server you
    // are handing the password to is the one you meant.
    allowInvalidCerts: bool('SMTP_ALLOW_INVALID_CERTS', false),
  };

  // Fail loudly rather than fall back to queueing. Asking for smtp means
  // expecting mail to arrive, and silently not sending is the failure mode
  // this whole path exists to remove. Names only -- no values in the message.
  if (transport === 'smtp') {
    const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'].filter((n) => !process.env[n]);
    if (missing.length) {
      throw new Error(
        `MAIL_TRANSPORT=smtp requires ${missing.join(', ')}. ` +
          'Set them in .env (chmod 600) or your secret manager, then check the ' +
          'connection with:  npm run mail:check -- you@example.com'
      );
    }
    if (smtp.allowInvalidCerts) {
      console.warn('[config] SMTP_ALLOW_INVALID_CERTS=1 — the mail server certificate is not being verified.');
    }
  }

  return {
    transport,
    from: process.env.MAIL_FROM || 'EAA Chapter 1699 <no-reply@eaa1699.org>',

    /**
     * Domains never to attempt delivery to.
     *
     * The defaults are the domains RFC 2606 reserves for documentation, which
     * is what the demo members and the test suites use. Nothing can receive
     * mail there, so an attempt only produces a bounce -- and enough bounces
     * against a new sending domain is how a chapter's mail starts going to
     * everyone's spam folder. The site is seeded with fictional members and its
     * tests generate real form submissions, so without this, switching on SMTP
     * in a development environment quietly damages the live domain's
     * reputation.
     */
    suppressDomains: new Set(
      (process.env.MAIL_SUPPRESS_DOMAINS ?? 'example.com,example.org,example.net,test,invalid,localhost')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    ),
    // Default replies to a mailbox somebody reads, since `from` is a no-reply.
    replyTo: (process.env.MAIL_REPLY_TO || '').trim(),
    // How often the background worker looks for due messages.
    pollSeconds: int('MAIL_POLL_SECONDS', 60),
    smtp,
  };
}

export const config = {
  env,
  isProd,
  isDev: !isProd,
  port: int('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',

  // Behind a reverse proxy (nginx / Caddy / Fly / Render) set TRUST_PROXY=1 so
  // req.ip and `secure` cookies reflect the real client connection.
  trustProxy: int('TRUST_PROXY', 0),

  /**
   * How to write `Location:` headers on redirects.
   *
   *   'prefix'   (default) prepend BASE_PATH. Correct when nothing in front
   *              rewrites redirects -- a plain nginx location block, or no
   *              proxy at all.
   *   'absolute' emit a fully-qualified URL built from BASE_URL + BASE_PATH.
   *              Use this behind proxies that rewrite Location headers.
   *              code-server's `/proxy/<port>/` prepends its own mount point,
   *              so a path we prefixed comes out prefixed twice and one we
   *              left bare comes out missing the outer hop. An absolute URL
   *              is passed through untouched, so it is right either way.
   *   'plain'    emit the path unchanged and let the proxy rewrite it.
   *
   * HTML links always carry BASE_PATH regardless: no proxy rewrites the body.
   */
  redirectMode: ['prefix', 'absolute', 'plain'].includes(process.env.REDIRECT_MODE || '')
    ? process.env.REDIRECT_MODE
    : 'prefix',

  /**
   * Path prefix the site is served under, e.g. "/chapter" when it lives at
   * example.org/chapter rather than at a domain root.
   *
   * Normally empty. It matters for development proxies (Coder, code-server,
   * Gitpod) that expose a port under a long path, and for shared hosting
   * where the chapter site is one app among several. Every generated URL is
   * prefixed with it, and incoming requests have it stripped, so the same
   * build works at a root or under a prefix.
   */
  basePath: (() => {
    const raw = (process.env.BASE_PATH || '').trim();
    if (!raw || raw === '/') return '';
    return `/${raw.replace(/^\/+|\/+$/g, '')}`;
  })(),

  rootDir,
  srcDir,
  viewsDir: path.join(srcDir, 'views'),
  publicDir: path.join(rootDir, 'public'),
  // The database and uploads live under dataDir by default, so pointing
  // DATA_DIR at a persistent volume moves everything stateful in one go.
  // DB_FILE and UPLOAD_DIR can still override individually.
  dataDir,
  uploadDir: process.env.UPLOAD_DIR || path.join(dataDir, 'uploads'),
  dbFile: process.env.DB_FILE || path.join(dataDir, 'eaa1699.sqlite'),

  secrets: {
    session: secret('SESSION_SECRET'),
    csrf: secret('CSRF_SECRET'),
    // Optional server-side "pepper" mixed into password hashes. Rotating it
    // invalidates every password, so it lives in config, never in the database.
    pepper: process.env.PASSWORD_PEPPER || '',
  },

  session: {
    cookieName: 'eaa1699.sid',
    maxAgeMs: int('SESSION_MAX_AGE_HOURS', 12) * 60 * 60 * 1000,
    secureCookies: bool('SECURE_COOKIES', isProd),
  },

  auth: {
    // Login throttling, enforced per account in addition to the per-IP limiter.
    maxFailedLogins: int('MAX_FAILED_LOGINS', 8),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
    resetTokenTtlMinutes: int('RESET_TOKEN_TTL_MINUTES', 60),
    inviteTtlDays: int('INVITE_TTL_DAYS', 14),
    minPasswordLength: int('MIN_PASSWORD_LENGTH', 12),
  },

  uploads: {
    maxBytes: int('UPLOAD_MAX_BYTES', 12 * 1024 * 1024),
    maxFilesPerTool: int('UPLOAD_MAX_FILES', 8),
    // Everything is re-encoded to these dimensions; originals are discarded.
    fullWidth: 1600,
    thumbWidth: 480,
  },

  mail: mailConfig(),

  /**
   * The nightly backup report: an email saying whether the backup is working,
   * proved by actually restoring it. See src/lib/backup-report.js.
   */
  backup: {
    // On in production, off in development, so a laptop or test container
    // does not email the chapter's admins a PROBLEM report every morning
    // about a backup it was never meant to have. BACKUP_REPORT=1 or 0
    // overrides either way. Only ever runs from server.js, never from tests or
    // scripts that merely import the app.
    reportEnabled: process.env.BACKUP_REPORT ? process.env.BACKUP_REPORT !== '0' : isProd,
    // Comma-separated. Empty means every active administrator.
    reportTo: (process.env.BACKUP_REPORT_TO || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Hour of the day, chapter time (Eastern), at or after which it is sent.
    reportHour: Math.min(23, Math.max(0, int('BACKUP_REPORT_HOUR', 6))),
    // Set by scripts/start.sh when a Tigris bucket (or other replica) is
    // attached. Unset means the database is not being backed up at all.
    replicaUrl: process.env.LITESTREAM_REPLICA_URL || '',
    litestreamConfig: process.env.LITESTREAM_CONFIG || path.join(rootDir, 'litestream.yml'),
  },

  site: {
    name: 'EAA Chapter 1699',
    tagline: 'Builders, pilots, and dreamers at South Albany Airport',
    chapterNumber: 1699,
    baseUrl: process.env.BASE_URL || `http://localhost:${int('PORT', 3000)}`,
    airport: {
      name: 'South Albany Airport',
      ident: '4B0',
      street: '6 Old School Road',
      city: 'Selkirk',
      state: 'NY',
      zip: '12158',
      latitude: 42.5632613,
      longitude: -73.8356388,
      runway: '2,853 ft turf/asphalt',
      fuel: '100LL and Jet A',
    },
    contactEmail: process.env.CONTACT_EMAIL || 'info@eaa1699.org',
    ein: '99-1529453',
  },

  /**
   * Origins allowed to submit forms.
   *
   * The origin check compares the browser's `Origin` header against the host
   * the request arrived on. Behind a reverse proxy those differ: the browser
   * says `https://chapter.example.org`, the app sees `localhost:3000`. So the
   * public origin has to be declared, which BASE_URL already does. Extra
   * hostnames (a bare domain alongside a www one, say) go in ALLOWED_ORIGINS,
   * comma separated.
   */
  allowedOrigins: (() => {
    const raw = [process.env.BASE_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')];
    const out = new Set();
    for (const value of raw) {
      const trimmed = (value || '').trim();
      if (!trimmed) continue;
      try {
        out.add(new URL(trimmed).origin);
      } catch {
        console.warn(`[config] ignoring unparseable allowed origin: ${trimmed}`);
      }
    }
    return out;
  })(),
};

export default config;
