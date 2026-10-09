import { all, get, run, nowIso } from '../db/index.js';

export const INTERESTS = [
  'I fly and want to meet local pilots',
  'I am building or restoring an aircraft',
  'I want to learn to fly',
  'I am a Young Eagles parent',
  'I used to fly and I miss it',
  'I just like airplanes',
];

/**
 * Records a membership request.
 *
 * Returns the new id, or `null` when the address already has an open
 * application (enforced by a partial unique index). The caller must answer
 * both cases identically -- a different response would turn this public form
 * into a way to test which addresses the chapter already knows.
 */
export function createApplication(fields) {
  try {
    const info = run(
      `INSERT INTO membership_applications
         (first_name, last_name, email, phone, eaa_number, aircraft, home_base,
          interest, message, ip_hash, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fields.firstName,
        fields.lastName,
        String(fields.email).trim().toLowerCase(),
        fields.phone,
        fields.eaaNumber,
        fields.aircraft,
        fields.homeBase,
        fields.interest,
        fields.message,
        fields.ipHash,
        fields.userAgent,
        nowIso(),
      ]
    );
    return Number(info.lastInsertRowid);
  } catch (err) {
    // UNIQUE violation on the open-application index: already asked, still
    // waiting. Anything else is a genuine fault and should surface.
    if (String(err.message).includes('UNIQUE')) return null;
    throw err;
  }
}

export function listApplications({ status = null } = {}) {
  const where = status ? 'WHERE a.status = ?' : '';
  const params = status ? [status] : [];
  return all(
    `SELECT a.*, r.first_name AS reviewer_first, r.last_name AS reviewer_last
       FROM membership_applications a
       LEFT JOIN users r ON r.id = a.reviewed_by
      ${where}
      ORDER BY a.status = 'pending' DESC, a.created_at DESC`,
    params
  );
}

export function getApplication(id) {
  return get('SELECT * FROM membership_applications WHERE id = ?', [Number(id)]) ?? null;
}

export function pendingCount() {
  return get("SELECT COUNT(*) AS n FROM membership_applications WHERE status = 'pending'").n;
}

export function markReviewed(id, { status, reviewerId, note = null, userId = null }) {
  run(
    `UPDATE membership_applications
        SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, user_id = ?
      WHERE id = ?`,
    [status, reviewerId, nowIso(), note, userId, Number(id)]
  );
}
