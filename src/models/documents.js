import { all, get, run, nowIso, transaction } from '../db/index.js';
import { BOARD_ROLES, canApprove, displayName } from './users.js';

/**
 * Chapter documents and their approval trail.
 *
 *   draft -> in_review -> approved            (a President or Vice President approves)
 *               \-> changes_requested -> (new version) -> draft ...
 *
 * An approval belongs to one version. Approved documents are not edited:
 * uploading again starts a revision (status back to draft) and the last
 * approved version stays visible to members until a newer one is published.
 */

export const KINDS = {
  minutes: 'Meeting minutes',
  agenda: 'Agenda',
  financial: 'Financial report',
  newsletter: 'Newsletter',
  bylaws: 'Bylaws and policies',
  other: 'Other',
};

export const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
};

export class DocumentStateError extends Error {
  constructor(message) {
    super(message);
    this.status = 409;
  }
}

const LIST_SQL = `
  SELECT d.*, v.id AS latest_version_id, v.number AS latest_number, v.original_name AS latest_name,
         u.first_name AS creator_first, u.last_name AS creator_last
    FROM documents d
    JOIN document_versions v ON v.document_id = d.id
     AND v.number = (SELECT MAX(number) FROM document_versions WHERE document_id = d.id)
    LEFT JOIN users u ON u.id = d.created_by
`;

export function getDocument(id) {
  if (!Number.isInteger(Number(id))) return null;
  return get(`${LIST_SQL} WHERE d.id = ?`, [Number(id)]) ?? null;
}

/** Everything, for the board's workspace. Needs-attention first, then newest. */
export function listAll() {
  return all(
    `${LIST_SQL}
      ORDER BY CASE d.status WHEN 'in_review' THEN 0 WHEN 'changes_requested' THEN 1 WHEN 'draft' THEN 2 ELSE 3 END,
               COALESCE(d.meeting_date, substr(d.created_at, 1, 10)) DESC, d.id DESC`
  );
}

/** What members can see: documents with a published version, newest meeting first. */
export function listPublished() {
  return all(
    `SELECT d.id, d.kind, d.title, d.meeting_date, d.created_at,
            v.id AS version_id, v.number, v.original_name, v.size, v.mime
       FROM documents d
       JOIN document_versions v ON v.id = d.published_version_id
      WHERE d.visibility = 'members'
      ORDER BY COALESCE(d.meeting_date, substr(d.created_at, 1, 10)) DESC, d.id DESC`
  );
}

export function getPublishedVersion(documentId) {
  return (
    get(
      `SELECT v.* FROM documents d
         JOIN document_versions v ON v.id = d.published_version_id
        WHERE d.id = ? AND d.visibility = 'members'`,
      [Number(documentId)]
    ) ?? null
  );
}

export function listVersions(documentId) {
  const versions = all(
    `SELECT v.*, u.first_name, u.last_name, s.first_name AS sub_first, s.last_name AS sub_last
       FROM document_versions v
       LEFT JOIN users u ON u.id = v.created_by
       LEFT JOIN users s ON s.id = v.submitted_by
      WHERE v.document_id = ? ORDER BY v.number DESC`,
    [Number(documentId)]
  );
  const reviews = all(
    `SELECT r.*, u.first_name, u.last_name
       FROM document_reviews r
       JOIN document_versions v ON v.id = r.version_id
       LEFT JOIN users u ON u.id = r.reviewer_id
      WHERE v.document_id = ? ORDER BY r.id`,
    [Number(documentId)]
  );
  return versions.map((v) => ({ ...v, reviews: reviews.filter((r) => r.version_id === v.id) }));
}

export function getVersion(documentId, number) {
  return (
    get('SELECT * FROM document_versions WHERE document_id = ? AND number = ?', [Number(documentId), Number(number)]) ?? null
  );
}

/** "Gary Jones (Vice President)": who did it, as it should read later. */
function actorLabel(user) {
  if (!user) return null;
  const office = user.board_role ? ` (${BOARD_ROLES[user.board_role]})` : '';
  return `${displayName(user)}${office}`;
}

function logEvent(documentId, { version = null, action, user = null, detail = null }) {
  run(
    `INSERT INTO document_events (document_id, version_number, action, actor_id, actor_label, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [documentId, version, action, user?.id ?? null, actorLabel(user), detail, nowIso()]
  );
}

/** Newest first. */
export function listEvents(documentId) {
  return all('SELECT * FROM document_events WHERE document_id = ? ORDER BY id DESC', [Number(documentId)]);
}

/** Creates a document and its first version in one step. */
export function createDocument({ kind, title, meetingDate, note, file, user }) {
  return transaction(() => {
    const ts = nowIso();
    const info = run(
      `INSERT INTO documents (kind, title, meeting_date, next_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 2, ?, ?, ?)`,
      [kind, title, meetingDate, user.id, ts, ts]
    );
    const id = Number(info.lastInsertRowid);
    insertVersion(id, 1, { note, file, userId: user.id, ts });
    logEvent(id, { version: 1, action: 'created', user, detail: file.originalName });
    return id;
  });
}

function insertVersion(documentId, number, { note, file, userId, ts }) {
  run(
    `INSERT INTO document_versions
       (document_id, number, original_name, stored_name, mime, size, sha256, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [documentId, number, file.originalName, file.storedName, file.mime, file.size, file.sha256, note ?? null, userId, ts]
  );
}

/** Adds a version. Not while a review is under way. An approved document goes back to draft. */
export function addVersion(documentId, { note, file, user }) {
  return transaction(() => {
    const doc = getDocument(documentId);
    if (!doc) throw new DocumentStateError('That document no longer exists.');
    if (doc.status === 'in_review') {
      throw new DocumentStateError('This document is waiting for a decision. Wait for the reviewer, or ask them to request changes.');
    }
    const number = doc.next_version;
    const ts = nowIso();
    insertVersion(doc.id, number, { note, file, userId: user.id, ts });
    run("UPDATE documents SET status = 'draft', next_version = ?, updated_at = ? WHERE id = ?", [number + 1, ts, doc.id]);
    logEvent(doc.id, { version: number, action: 'version_added', user, detail: file.originalName });
    return number;
  });
}

export function submitForReview(documentId, user) {
  return transaction(() => {
    const doc = getDocument(documentId);
    if (!doc) throw new DocumentStateError('That document no longer exists.');
    if (!['draft', 'changes_requested'].includes(doc.status)) {
      throw new DocumentStateError('Only a draft can be sent for review.');
    }
    const ts = nowIso();
    run('UPDATE document_versions SET submitted_by = ?, submitted_at = ? WHERE document_id = ? AND number = ?', [
      user.id,
      ts,
      doc.id,
      doc.latest_number,
    ]);
    run("UPDATE documents SET status = 'in_review', updated_at = ? WHERE id = ?", [ts, doc.id]);
    logEvent(doc.id, { version: doc.latest_number, action: 'submitted', user });
    return doc;
  });
}

/**
 * Records a decision on the version currently under review. `versionNumber` is
 * the version the reviewer was looking at; if someone has replaced it since,
 * the decision is refused rather than landing on a file the reviewer never saw.
 */
export function recordReview(documentId, { versionNumber, decision, comment, reviewer }) {
  return transaction(() => {
    const doc = getDocument(documentId);
    if (!doc) throw new DocumentStateError('That document no longer exists.');
    if (doc.status !== 'in_review') throw new DocumentStateError('This document is not waiting for a decision.');
    if (Number(versionNumber) !== doc.latest_number) {
      throw new DocumentStateError('A newer version was uploaded while you were looking. Review that one instead.');
    }
    const version = getVersion(doc.id, doc.latest_number);
    const ts = nowIso();
    run(
      `INSERT INTO document_reviews (version_id, reviewer_id, reviewer_office, decision, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [version.id, reviewer.id, reviewer.board_role ?? null, decision, comment || null, ts]
    );
    run('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', [
      decision === 'approved' ? 'approved' : 'changes_requested',
      ts,
      doc.id,
    ]);
    logEvent(doc.id, { version: version.number, action: decision, user: reviewer, detail: comment || null });
    return { doc, version };
  });
}

/** Makes the approved version visible to every member. */
export function publish(documentId, user) {
  return transaction(() => {
    const doc = getDocument(documentId);
    if (!doc) throw new DocumentStateError('That document no longer exists.');
    if (doc.status !== 'approved') throw new DocumentStateError('Only an approved document can be published.');
    const version = getVersion(doc.id, doc.latest_number);
    run("UPDATE documents SET published_version_id = ?, visibility = 'members', updated_at = ? WHERE id = ?", [
      version.id,
      nowIso(),
      doc.id,
    ]);
    logEvent(doc.id, { version: version.number, action: 'published', user });
    return version;
  });
}

export function unpublish(documentId, user) {
  transaction(() => {
    const doc = getDocument(documentId);
    if (!doc?.published_version_id) return;
    const was = get('SELECT number FROM document_versions WHERE id = ?', [doc.published_version_id]);
    run("UPDATE documents SET published_version_id = NULL, visibility = 'board', updated_at = ? WHERE id = ?", [
      nowIso(),
      doc.id,
    ]);
    logEvent(doc.id, { version: was?.number ?? null, action: 'unpublished', user });
  });
}

/** True when the version carries an approval: a record, so only an approver may remove it. */
function wasApproved(versionId) {
  return Boolean(get("SELECT 1 AS x FROM document_reviews WHERE version_id = ? AND decision = 'approved'", [versionId]));
}

/** Why this version cannot be deleted by this person right now, or null if it can. */
export function deletionBlocker(doc, versions, version, user) {
  if (!user?.board_role) return 'Only a chapter officer can delete a version.';
  if (versions.length <= 1) return 'This is the only version, so it cannot be deleted.';
  if (doc.published_version_id === version.id) {
    return 'Members can read this version. Take the document down from members first.';
  }
  if (doc.status === 'in_review' && version.number === doc.latest_number) {
    return 'This version is waiting for a decision. Ask the reviewer to decide first.';
  }
  if (wasApproved(version.id) && !canApprove(user)) {
    return 'Only the President or Vice President can delete an approved version.';
  }
  return null;
}

/**
 * Deletes one version and its file's record, and logs it. Version numbers are
 * not renumbered. Returns the stored file name so the caller can remove it
 * from disk once the database change has stuck.
 */
export function deleteVersion(documentId, number, user) {
  return transaction(() => {
    const doc = getDocument(documentId);
    const version = doc && getVersion(doc.id, number);
    if (!version) throw new DocumentStateError('That version no longer exists.');
    const versions = all('SELECT id, number FROM document_versions WHERE document_id = ?', [doc.id]);
    const blocker = deletionBlocker(doc, versions, version, user);
    if (blocker) throw new DocumentStateError(blocker);

    run('DELETE FROM document_versions WHERE id = ?', [version.id]);

    // If the newest version went, the document goes back to whatever the one
    // before it was: approved, awaiting changes, or a plain draft.
    let status = doc.status;
    if (version.number === doc.latest_number) {
      const latest = get('SELECT * FROM document_versions WHERE document_id = ? ORDER BY number DESC LIMIT 1', [doc.id]);
      const last = get('SELECT decision FROM document_reviews WHERE version_id = ? ORDER BY id DESC LIMIT 1', [latest.id]);
      status = last?.decision === 'approved' ? 'approved' : last?.decision === 'changes_requested' ? 'changes_requested' : 'draft';
    }
    run('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), doc.id]);
    logEvent(doc.id, {
      version: version.number,
      action: 'version_deleted',
      user,
      detail: `${version.original_name} · SHA-256 ${version.sha256.slice(0, 16)}`,
    });
    return version.stored_name;
  });
}

export function pendingReviewCount() {
  return get("SELECT COUNT(*) AS n FROM documents WHERE status = 'in_review'").n;
}
