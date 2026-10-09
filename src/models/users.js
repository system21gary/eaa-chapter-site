import { all, get, run, nowIso } from '../db/index.js';
import { hashPassword } from '../lib/passwords.js';
import { createToken, hashToken, minutesFromNow, daysFromNow, isExpired } from '../lib/tokens.js';
import config from '../config.js';

/** Columns safe to hand to a template. Never includes password_hash. */
const PUBLIC_COLUMNS = `
  id, email, email_verified, first_name, last_name, display_name, phone,
  eaa_number, aircraft, home_base, bio, avatar_path, role, status,
  password_set_at, last_login_at, created_at, updated_at
`;

export function findById(id) {
  if (!Number.isInteger(Number(id))) return null;
  return get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [Number(id)]) ?? null;
}

/** Includes the hash -- only for the login path. */
export function findForAuth(email) {
  return (
    get(
      `SELECT id, email, first_name, last_name, role, status, password_hash,
              failed_logins, locked_until
         FROM users WHERE email = ?`,
      [String(email ?? '').trim().toLowerCase()]
    ) ?? null
  );
}

export function findByEmail(email) {
  return (
    get(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = ?`, [
      String(email ?? '').trim().toLowerCase(),
    ]) ?? null
  );
}

export function listMembers({ status = null, search = null } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (search) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR aircraft LIKE ?)');
    const like = `%${String(search).replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  return all(
    `SELECT ${PUBLIC_COLUMNS} FROM users
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE`,
    params
  );
}

export function displayName(user) {
  if (!user) return 'Unknown';
  return user.display_name?.trim() || `${user.first_name} ${user.last_name}`.trim();
}

/**
 * Creates an account with **no password**. The member sets their own via a
 * one-time link, so no plaintext password is ever chosen by, transmitted to,
 * or known by an administrator.
 */
export function createUser({
  email,
  firstName,
  lastName,
  role = 'member',
  status = 'pending',
  phone = null,
  eaaNumber = null,
  aircraft = null,
  homeBase = null,
}) {
  const ts = nowIso();
  const info = run(
    `INSERT INTO users
       (email, first_name, last_name, role, status, phone, eaa_number, aircraft,
        home_base, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(email).trim().toLowerCase(),
      firstName,
      lastName,
      role,
      status,
      phone,
      eaaNumber,
      aircraft,
      homeBase,
      ts,
      ts,
    ]
  );
  return findById(Number(info.lastInsertRowid));
}

export function updateProfile(userId, fields) {
  const allowed = ['display_name', 'phone', 'eaa_number', 'aircraft', 'home_base', 'bio'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }
  if (!sets.length) return findById(userId);
  sets.push('updated_at = ?');
  params.push(nowIso(), userId);
  run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return findById(userId);
}

export function setAvatar(userId, avatarPath) {
  run('UPDATE users SET avatar_path = ?, updated_at = ? WHERE id = ?', [
    avatarPath,
    nowIso(),
    userId,
  ]);
}

export function setRole(userId, role) {
  run('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [role, nowIso(), userId]);
}

export function setStatus(userId, status) {
  run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), userId]);
}

/* ------------------------------------------------------ login bookkeeping */

export function recordFailedLogin(userId) {
  const row = get('SELECT failed_logins FROM users WHERE id = ?', [userId]);
  const attempts = (row?.failed_logins ?? 0) + 1;
  const lockUntil =
    attempts >= config.auth.maxFailedLogins ? minutesFromNow(config.auth.lockoutMinutes) : null;
  run('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?', [
    attempts,
    lockUntil,
    userId,
  ]);
  return { attempts, lockedUntil: lockUntil };
}

export function recordSuccessfulLogin(userId) {
  run(
    'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
    [nowIso(), userId]
  );
}

export function isLockedOut(user) {
  return Boolean(user?.locked_until) && !isExpired(user.locked_until);
}

/* --------------------------------------------------- password reset flow */

/**
 * Issues a single-use reset token. Any previously outstanding token for the
 * account is invalidated first, so a stale link in an old inbox cannot be used
 * after a newer one is requested.
 */
export function createPasswordResetToken(userId, ip = null) {
  run('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL', [
    nowIso(),
    userId,
  ]);
  const { raw, hash } = createToken(32);
  run(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, hash, minutesFromNow(config.auth.resetTokenTtlMinutes), ip, nowIso()]
  );
  return raw;
}

export function consumePasswordResetToken(rawToken) {
  const row = get(
    `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
    [hashToken(rawToken)]
  );
  if (!row || row.used_at || isExpired(row.expires_at)) return null;
  run('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row.user_id;
}

/** Look up a token without spending it, so the reset form can be rendered. */
export function peekPasswordResetToken(rawToken) {
  const row = get(
    `SELECT user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
    [hashToken(rawToken)]
  );
  if (!row || row.used_at || isExpired(row.expires_at)) return null;
  return row.user_id;
}

export async function setPassword(userId, plaintext) {
  const hash = await hashPassword(plaintext);
  const ts = nowIso();
  run(
    `UPDATE users
        SET password_hash = ?, password_set_at = ?, updated_at = ?,
            failed_logins = 0, locked_until = NULL,
            status = CASE WHEN status = 'pending' THEN 'active' ELSE status END
      WHERE id = ?`,
    [hash, ts, ts, userId]
  );
  // The plaintext is never returned, logged, or retained beyond this call.
}

/* ---------------------------------------------------------------- invites */

export function createInvite({ email, role = 'member', invitedBy = null, note = null }) {
  const { raw, hash } = createToken(32);
  run(
    `INSERT INTO invites (email, token_hash, role, invited_by, note, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      String(email).trim().toLowerCase(),
      hash,
      role,
      invitedBy,
      note,
      daysFromNow(config.auth.inviteTtlDays),
      nowIso(),
    ]
  );
  return raw;
}

export function consumeInvite(rawToken) {
  const row = get(
    'SELECT id, email, role, expires_at, accepted_at FROM invites WHERE token_hash = ?',
    [hashToken(rawToken)]
  );
  if (!row || row.accepted_at || isExpired(row.expires_at)) return null;
  run('UPDATE invites SET accepted_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row;
}

export function pendingInvites() {
  return all(
    `SELECT i.id, i.email, i.role, i.note, i.expires_at, i.created_at,
            u.first_name AS by_first, u.last_name AS by_last
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.accepted_at IS NULL
      ORDER BY i.created_at DESC`
  );
}

export function countAdmins() {
  return get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'").n;
}
