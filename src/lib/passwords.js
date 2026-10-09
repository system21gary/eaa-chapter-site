import crypto from 'node:crypto';
import { promisify } from 'node:util';
import config from '../config.js';

const scrypt = promisify(crypto.scrypt);

/**
 * Password storage.
 *
 * We never store, log, or email a password. What lands in the database is a
 * one-way scrypt digest: `scrypt$N$r$p$<salt>$<digest>`, both base64url.
 * Verification re-derives the digest from the supplied password and compares
 * it in constant time -- there is no operation that turns a stored value back
 * into a password, which is why the only recovery path is a reset link.
 *
 * scrypt is memory-hard (unlike PBKDF2) and ships in Node's standard library
 * (unlike argon2/bcrypt), so there is no native module to keep patched.
 */
const PARAMS = {
  N: 1 << 15, // 32768 iterations
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
  // 128 * N * r = 32 MiB of working memory; give scrypt headroom above that.
  maxmem: 96 * 1024 * 1024,
};

function peppered(password) {
  // The pepper lives in the environment, not the database. A stolen database
  // alone is therefore not enough to mount an offline cracking run.
  return config.secrets.pepper ? `${password}${config.secrets.pepper}` : password;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(PARAMS.saltBytes);
  const digest = await scrypt(peppered(password), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: PARAMS.maxmem,
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    digest.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, digestB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters so a tampered row cannot turn a login into a DoS.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let expected;
  let salt;
  try {
    expected = Buffer.from(digestB64, 'base64url');
    salt = Buffer.from(saltB64, 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0 || salt.length === 0) return false;

  const actual = await scrypt(peppered(password), salt, expected.length, {
    N,
    r,
    p,
    maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected);
}

/**
 * Burn roughly the same amount of CPU as a real verification.
 *
 * Called when the submitted email has no account (or has no password set) so
 * that response timing does not reveal which addresses are registered.
 */
const DUMMY_HASH = await hashPassword(crypto.randomBytes(24).toString('base64url'));
export async function fakeVerify(password) {
  try {
    await verifyPassword(String(password ?? ''), DUMMY_HASH);
  } catch {
    /* timing decoy only */
  }
  return false;
}

// The passwords attackers try first. Short list on purpose: it catches the
// genuinely careless choices without pretending to be a real breach corpus.
const COMMON = new Set(
  [
    'password', 'password1', 'password123', 'passw0rd', 'letmein', 'welcome',
    'qwerty', 'qwertyuiop', 'iloveyou', 'admin', 'administrator', 'abc123',
    '123456', '1234567', '12345678', '123456789', '1234567890', '111111',
    'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
    'trustno1', 'changeme', 'secret', 'master', 'shadow', 'superman',
    // Aviation-flavoured guesses this site would actually attract.
    'aviation', 'airplane', 'aircraft', 'cessna172', 'pilotpilot', 'flyfly',
    'eaa1699', 'eaachapter1699', 'southalbany', 'pancakes', 'oshkosh',
    'tailwheel', 'skyhawk', 'piperCub', 'vansrv', 'rv-12', 'n12345',
  ].map((s) => s.toLowerCase())
);

/**
 * Length-first strength policy, in line with NIST SP 800-63B: long passphrases
 * beat short character soup, and we reject known-bad choices rather than
 * demanding a symbol nobody remembers.
 */
export function checkPasswordStrength(password, { email = '', name = '' } = {}) {
  const problems = [];
  const pw = String(password ?? '');
  const min = config.auth.minPasswordLength;

  if (pw.length < min) problems.push(`Use at least ${min} characters.`);
  if (pw.length > 200) problems.push('Keep it under 200 characters.');

  const normalized = pw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (COMMON.has(pw.toLowerCase()) || COMMON.has(normalized)) {
    problems.push('That is one of the first passwords an attacker tries. Pick something else.');
  }

  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && normalized.includes(local.replace(/[^a-z0-9]/g, ''))) {
    problems.push('Do not build your password out of your email address.');
  }
  for (const part of String(name).toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && normalized.includes(part)) {
      problems.push('Do not build your password out of your name.');
      break;
    }
  }

  if (/^(.)\1+$/.test(pw)) problems.push('That is a single repeated character.');
  if (/^(0123456789|1234567890|abcdefghij)/.test(pw.toLowerCase())) {
    problems.push('Sequential keyboard runs are guessed immediately.');
  }

  // Distinct-character count is a cheap proxy for entropy that does not punish
  // long passphrases the way a "1 upper, 1 symbol" rule does.
  const distinct = new Set(pw).size;
  if (pw.length >= min && distinct < 5) {
    problems.push('Mix in more distinct characters.');
  }

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/**
 * Optional k-anonymity check against Have I Been Pwned. Only the first five
 * characters of the SHA-1 leave this server, and the whole feature is off
 * unless PWNED_CHECK=1, so the site works fully offline.
 */
export async function isBreachedPassword(password) {
  if (process.env.PWNED_CHECK !== '1') return false;
  try {
    const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    // Never let an outage on a third-party service block a password reset.
    return false;
  }
}
