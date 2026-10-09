import { all, get, run, transaction, nowIso } from '../db/index.js';

const TOOL_COLUMNS = `
  t.id, t.owner_id, t.category_id, t.name, t.brand, t.model, t.description,
  t.condition, t.availability, t.location_label, t.location_notes,
  t.latitude, t.longitude, t.loan_terms, t.requires_checkout, t.deposit,
  t.manual_url, t.created_at, t.updated_at,
  c.label AS category_label, c.slug AS category_slug, c.icon AS category_icon,
  u.first_name AS owner_first, u.last_name AS owner_last,
  u.display_name AS owner_display, u.avatar_path AS owner_avatar,
  u.home_base AS owner_home_base
`;

export function listCategories() {
  return all(
    `SELECT c.*, (SELECT COUNT(*) FROM tools t WHERE t.category_id = c.id) AS tool_count
       FROM tool_categories c ORDER BY c.sort, c.label`
  );
}

export function listTools({ category = null, search = null, availability = null, ownerId = null, limit = 60, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (category) {
    where.push('c.slug = ?');
    params.push(category);
  }
  if (availability) {
    where.push('t.availability = ?');
    params.push(availability);
  }
  if (ownerId) {
    where.push('t.owner_id = ?');
    params.push(Number(ownerId));
  }
  if (search) {
    // LIKE with bound parameters -- the wildcards are ours, the text is theirs,
    // and % / _ in their input are neutralised so a search cannot broaden
    // itself unexpectedly.
    const like = `%${String(search).replace(/[%_\\]/g, '\\$&')}%`;
    where.push(
      `(t.name LIKE ? ESCAPE '\\' OR t.brand LIKE ? ESCAPE '\\' OR t.model LIKE ? ESCAPE '\\'
        OR t.description LIKE ? ESCAPE '\\' OR t.location_label LIKE ? ESCAPE '\\')`
    );
    params.push(like, like, like, like, like);
  }

  params.push(Math.min(Number(limit) || 60, 200), Math.max(Number(offset) || 0, 0));

  const rows = all(
    `SELECT ${TOOL_COLUMNS},
            (SELECT thumb_path FROM tool_images i WHERE i.tool_id = t.id ORDER BY i.sort, i.id LIMIT 1) AS thumb_path,
            (SELECT COUNT(*) FROM tool_images i WHERE i.tool_id = t.id) AS image_count
       FROM tools t
       LEFT JOIN tool_categories c ON c.id = t.category_id
       JOIN users u ON u.id = t.owner_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.availability = 'available' DESC, t.updated_at DESC
      LIMIT ? OFFSET ?`,
    params
  );
  return rows;
}

export function countTools(filters = {}) {
  const rows = listTools({ ...filters, limit: 200, offset: 0 });
  return rows.length;
}

export function getTool(id) {
  const tool = get(
    `SELECT ${TOOL_COLUMNS}, u.email AS owner_email, u.phone AS owner_phone
       FROM tools t
       LEFT JOIN tool_categories c ON c.id = t.category_id
       JOIN users u ON u.id = t.owner_id
      WHERE t.id = ?`,
    [Number(id)]
  );
  if (!tool) return null;
  tool.images = all(
    'SELECT id, full_path, thumb_path, alt, width, height FROM tool_images WHERE tool_id = ? ORDER BY sort, id',
    [tool.id]
  );
  return tool;
}

export function createTool(fields) {
  const ts = nowIso();
  const info = run(
    `INSERT INTO tools
       (owner_id, category_id, name, brand, model, description, condition,
        availability, location_label, location_notes, latitude, longitude,
        loan_terms, requires_checkout, deposit, manual_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.ownerId,
      fields.categoryId,
      fields.name,
      fields.brand,
      fields.model,
      fields.description,
      fields.condition,
      fields.availability,
      fields.locationLabel,
      fields.locationNotes,
      fields.latitude,
      fields.longitude,
      fields.loanTerms,
      fields.requiresCheckout ? 1 : 0,
      fields.deposit,
      fields.manualUrl,
      ts,
      ts,
    ]
  );
  return Number(info.lastInsertRowid);
}

export function updateTool(id, fields) {
  run(
    `UPDATE tools SET
       category_id = ?, name = ?, brand = ?, model = ?, description = ?,
       condition = ?, availability = ?, location_label = ?, location_notes = ?,
       latitude = ?, longitude = ?, loan_terms = ?, requires_checkout = ?,
       deposit = ?, manual_url = ?, updated_at = ?
     WHERE id = ?`,
    [
      fields.categoryId,
      fields.name,
      fields.brand,
      fields.model,
      fields.description,
      fields.condition,
      fields.availability,
      fields.locationLabel,
      fields.locationNotes,
      fields.latitude,
      fields.longitude,
      fields.loanTerms,
      fields.requiresCheckout ? 1 : 0,
      fields.deposit,
      fields.manualUrl,
      nowIso(),
      Number(id),
    ]
  );
}

export function setAvailability(id, availability) {
  run('UPDATE tools SET availability = ?, updated_at = ? WHERE id = ?', [
    availability,
    nowIso(),
    Number(id),
  ]);
}

export function deleteTool(id) {
  return transaction(() => {
    const images = all('SELECT full_path, thumb_path FROM tool_images WHERE tool_id = ?', [
      Number(id),
    ]);
    run('DELETE FROM tools WHERE id = ?', [Number(id)]);
    return images;
  });
}

/* ----------------------------------------------------------------- images */

export function addImage(toolId, { fullPath, thumbPath, alt, width, height }) {
  const next = get('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM tool_images WHERE tool_id = ?', [
    Number(toolId),
  ]).s;
  const info = run(
    `INSERT INTO tool_images (tool_id, full_path, thumb_path, alt, width, height, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(toolId), fullPath, thumbPath, alt ?? null, width, height, next, nowIso()]
  );
  return Number(info.lastInsertRowid);
}

export function countImages(toolId) {
  return get('SELECT COUNT(*) AS n FROM tool_images WHERE tool_id = ?', [Number(toolId)]).n;
}

export function getImage(imageId) {
  return (
    get(
      `SELECT i.*, t.owner_id FROM tool_images i JOIN tools t ON t.id = i.tool_id WHERE i.id = ?`,
      [Number(imageId)]
    ) ?? null
  );
}

export function deleteImage(imageId) {
  run('DELETE FROM tool_images WHERE id = ?', [Number(imageId)]);
}

/* -------------------------------------------------------- borrow requests */

export function createBorrowRequest({ toolId, requesterId, message, neededFrom, neededTo }) {
  const info = run(
    `INSERT INTO borrow_requests (tool_id, requester_id, message, needed_from, needed_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [Number(toolId), Number(requesterId), message, neededFrom, neededTo, nowIso()]
  );
  return Number(info.lastInsertRowid);
}

export function getBorrowRequest(id) {
  return (
    get(
      `SELECT b.*, t.name AS tool_name, t.owner_id,
              r.first_name AS req_first, r.last_name AS req_last, r.email AS req_email,
              o.first_name AS owner_first, o.last_name AS owner_last, o.email AS owner_email
         FROM borrow_requests b
         JOIN tools t ON t.id = b.tool_id
         JOIN users r ON r.id = b.requester_id
         JOIN users o ON o.id = t.owner_id
        WHERE b.id = ?`,
      [Number(id)]
    ) ?? null
  );
}

/** Requests for tools I own (inbox) plus requests I have made (outbox). */
export function requestsForOwner(ownerId, { status = null } = {}) {
  const params = [Number(ownerId)];
  let clause = '';
  if (status) {
    clause = 'AND b.status = ?';
    params.push(status);
  }
  return all(
    `SELECT b.*, t.name AS tool_name,
            r.first_name AS req_first, r.last_name AS req_last,
            r.display_name AS req_display, r.email AS req_email, r.phone AS req_phone
       FROM borrow_requests b
       JOIN tools t ON t.id = b.tool_id
       JOIN users r ON r.id = b.requester_id
      WHERE t.owner_id = ? ${clause}
      ORDER BY b.status = 'pending' DESC, b.created_at DESC`,
    params
  );
}

export function requestsByRequester(requesterId) {
  return all(
    `SELECT b.*, t.name AS tool_name,
            o.first_name AS owner_first, o.last_name AS owner_last, o.display_name AS owner_display
       FROM borrow_requests b
       JOIN tools t ON t.id = b.tool_id
       JOIN users o ON o.id = t.owner_id
      WHERE b.requester_id = ?
      ORDER BY b.created_at DESC`,
    [Number(requesterId)]
  );
}

export function respondToRequest(id, { status, reply }) {
  run('UPDATE borrow_requests SET status = ?, owner_reply = ?, responded_at = ? WHERE id = ?', [
    status,
    reply,
    nowIso(),
    Number(id),
  ]);
}

export function pendingRequestCount(ownerId) {
  return get(
    `SELECT COUNT(*) AS n FROM borrow_requests b JOIN tools t ON t.id = b.tool_id
      WHERE t.owner_id = ? AND b.status = 'pending'`,
    [Number(ownerId)]
  ).n;
}

/** Has this member already got an open request against this tool? */
export function hasOpenRequest(toolId, requesterId) {
  return Boolean(
    get(
      `SELECT 1 FROM borrow_requests
        WHERE tool_id = ? AND requester_id = ? AND status IN ('pending','approved')`,
      [Number(toolId), Number(requesterId)]
    )
  );
}

export function lockerStats() {
  return {
    tools: get('SELECT COUNT(*) AS n FROM tools').n,
    owners: get('SELECT COUNT(DISTINCT owner_id) AS n FROM tools').n,
    available: get("SELECT COUNT(*) AS n FROM tools WHERE availability = 'available'").n,
    onLoan: get("SELECT COUNT(*) AS n FROM tools WHERE availability = 'on-loan'").n,
  };
}
