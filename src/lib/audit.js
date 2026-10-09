import config from '../config.js';
import { all, run, nowIso } from '../db/index.js';
import { hashIp } from './tokens.js';

/**
 * Append-only record of security-relevant actions.
 *
 * Deliberately never stores request bodies, passwords, or tokens -- only who
 * did what to which record. Client IPs are stored as a keyed digest so the log
 * is useful for spotting a credential-stuffing run without becoming a pile of
 * personal data.
 */
export function audit(req, action, { entity = null, entityId = null, detail = null, userId } = {}) {
  try {
    run(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, detail, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ?? req?.session?.userId ?? null,
        action,
        entity,
        entityId == null ? null : String(entityId),
        detail == null ? null : String(detail).slice(0, 500),
        hashIp(req?.ip, config.secrets.session),
        nowIso(),
      ]
    );
  } catch (err) {
    // Auditing must never break the request it is describing.
    console.error('[audit] failed to record', action, err.message);
  }
}

export function recentAudit(limit = 100) {
  return all(
    `SELECT a.*, u.first_name, u.last_name, u.email
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC
      LIMIT ?`,
    [Math.min(Number(limit) || 100, 500)]
  );
}
