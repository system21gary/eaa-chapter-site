import { all, get, run, nowIso } from '../db/index.js';
import { renderMarkdown, excerpt } from '../lib/markdown.js';
import { slugify } from '../lib/validate.js';

export const BUILD_KINDS = ['kit', 'plans', 'restoration', 'maintenance', 'ultralight', 'other'];
export const BUILD_STATUSES = [
  'planning',
  'building',
  'painting',
  'inspection',
  'flying',
  'paused',
  'sold',
];

/** Human labels, kept here so the templates never hard-code a database value. */
export const STATUS_LABELS = {
  planning: 'Planning',
  building: 'Building',
  painting: 'Paint &amp; finish',
  inspection: 'Awaiting inspection',
  flying: 'Flying',
  paused: 'On hold',
  sold: 'Sold / passed on',
};

export const KIND_LABELS = {
  kit: 'Kit build',
  plans: 'Plans built',
  restoration: 'Restoration',
  maintenance: 'Maintenance project',
  ultralight: 'Ultralight',
  other: 'Project',
};

const LIST_COLUMNS = `
  b.id, b.slug, b.title, b.aircraft_type, b.tail_number, b.build_kind,
  b.status, b.percent_complete, b.started_on, b.first_flight_on, b.summary,
  b.cover_path, b.cover_alt, b.visibility, b.featured, b.hangar,
  b.created_at, b.updated_at,
  u.id AS owner_id, u.first_name AS owner_first, u.last_name AS owner_last,
  u.display_name AS owner_display, u.avatar_path AS owner_avatar
`;

function uniqueSlug(title, aircraftType, excludeId = null) {
  // Prefer the project's own name; only fall back to the aircraft type when
  // that would collide, so URLs read like /builds/martas-rv-7a.
  const base = slugify(title, { maxLength: 70 });
  const candidates = [base, slugify(`${title} ${aircraftType}`, { maxLength: 70 })];

  for (const candidate of candidates) {
    if (!get('SELECT id FROM builds WHERE slug = ? AND id IS NOT ?', [candidate, excludeId])) {
      return candidate;
    }
  }

  let n = 2;
  for (;;) {
    const candidate = `${base}-${n++}`;
    if (!get('SELECT id FROM builds WHERE slug = ? AND id IS NOT ?', [candidate, excludeId])) {
      return candidate;
    }
  }
}

/**
 * Visibility is applied in SQL. A member-only project simply cannot appear in
 * the result set for an anonymous visitor, so the public page has no way to
 * leak one even if a template forgets to check.
 */
export function listBuilds({ viewer = null, status = null, kind = null, ownerId = null, limit = 60, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (!viewer) where.push("b.visibility = 'public'");
  if (status) {
    where.push('b.status = ?');
    params.push(status);
  }
  if (kind) {
    where.push('b.build_kind = ?');
    params.push(kind);
  }
  if (ownerId) {
    where.push('b.owner_id = ?');
    params.push(Number(ownerId));
  }
  params.push(Math.min(Number(limit) || 60, 200), Math.max(Number(offset) || 0, 0));

  return all(
    `SELECT ${LIST_COLUMNS},
            (SELECT COUNT(*) FROM build_updates x
              WHERE x.build_id = b.id AND x.status = 'published') AS update_count,
            (SELECT MAX(posted_at) FROM build_updates x
              WHERE x.build_id = b.id AND x.status = 'published') AS last_update_at,
            (SELECT COUNT(*) FROM build_cheers c WHERE c.build_id = b.id) AS cheers
       FROM builds b
       JOIN users u ON u.id = b.owner_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.featured DESC,
               CASE b.status WHEN 'flying' THEN 1 WHEN 'building' THEN 0 ELSE 2 END,
               COALESCE((SELECT MAX(posted_at) FROM build_updates x
                          WHERE x.build_id = b.id AND x.status = 'published'), b.updated_at) DESC
      LIMIT ? OFFSET ?`,
    params
  );
}

export function getBuildBySlug(slug, { viewer = null } = {}) {
  const build = get(
    `SELECT b.*, u.first_name AS owner_first, u.last_name AS owner_last,
            u.display_name AS owner_display, u.avatar_path AS owner_avatar,
            u.aircraft AS owner_aircraft, u.bio AS owner_bio, u.home_base AS owner_home_base
       FROM builds b JOIN users u ON u.id = b.owner_id
      WHERE b.slug = ?`,
    [slug]
  );
  if (!build) return null;
  if (build.visibility === 'members' && !viewer) return null;
  return build;
}

export function getBuildById(id) {
  return get('SELECT * FROM builds WHERE id = ?', [Number(id)]) ?? null;
}

export function saveBuild(fields, id = null) {
  const ts = nowIso();
  const bodyHtml = fields.bodyMd ? renderMarkdown(fields.bodyMd) : null;
  const summary = fields.summary || (fields.bodyMd ? excerpt(fields.bodyMd, 180) : null);

  if (id) {
    const existing = getBuildById(id);
    run(
      `UPDATE builds SET
         title = ?, slug = ?, aircraft_type = ?, tail_number = ?, build_kind = ?,
         status = ?, percent_complete = ?, started_on = ?, first_flight_on = ?,
         engine = ?, panel = ?, hangar = ?, summary = ?, body_md = ?, body_html = ?,
         cover_path = ?, cover_alt = ?, external_log_url = ?, visibility = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        fields.title,
        fields.title !== existing.title || fields.aircraftType !== existing.aircraft_type
          ? uniqueSlug(fields.title, fields.aircraftType, id)
          : existing.slug,
        fields.aircraftType,
        fields.tailNumber,
        fields.buildKind,
        fields.status,
        fields.percentComplete,
        fields.startedOn,
        fields.firstFlightOn,
        fields.engine,
        fields.panel,
        fields.hangar,
        summary,
        fields.bodyMd,
        bodyHtml,
        'coverPath' in fields ? fields.coverPath : existing.cover_path,
        fields.coverAlt,
        fields.externalLogUrl,
        fields.visibility,
        ts,
        Number(id),
      ]
    );
    return Number(id);
  }

  const info = run(
    `INSERT INTO builds
       (owner_id, slug, title, aircraft_type, tail_number, build_kind, status,
        percent_complete, started_on, first_flight_on, engine, panel, hangar,
        summary, body_md, body_html, cover_path, cover_alt, external_log_url,
        visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fields.ownerId,
      uniqueSlug(fields.title, fields.aircraftType),
      fields.title,
      fields.aircraftType,
      fields.tailNumber,
      fields.buildKind,
      fields.status,
      fields.percentComplete,
      fields.startedOn,
      fields.firstFlightOn,
      fields.engine,
      fields.panel,
      fields.hangar,
      summary,
      fields.bodyMd,
      bodyHtml,
      fields.coverPath ?? null,
      fields.coverAlt ?? null,
      fields.externalLogUrl,
      fields.visibility,
      ts,
      ts,
    ]
  );
  return Number(info.lastInsertRowid);
}

export function setFeatured(id, featured) {
  run('UPDATE builds SET featured = ?, updated_at = ? WHERE id = ?', [
    featured ? 1 : 0,
    nowIso(),
    Number(id),
  ]);
}

export function deleteBuild(id) {
  const photos = all(
    `SELECT p.full_path, p.thumb_path
       FROM build_update_photos p
       JOIN build_updates x ON x.id = p.update_id
      WHERE x.build_id = ?`,
    [Number(id)]
  );
  run('DELETE FROM builds WHERE id = ?', [Number(id)]);
  return photos;
}

/* ------------------------------------------------------------ log entries */

export function listUpdates(buildId, { viewer = null, limit = 100 } = {}) {
  const rows = all(
    `SELECT x.*, u.first_name, u.last_name, u.display_name, u.avatar_path
       FROM build_updates x
       LEFT JOIN users u ON u.id = x.author_id
      WHERE x.build_id = ? ${viewer ? '' : "AND x.status = 'published'"}
      ORDER BY x.posted_at DESC, x.id DESC
      LIMIT ?`,
    [Number(buildId), Math.min(Number(limit) || 100, 300)]
  );
  for (const row of rows) {
    row.photos = all(
      'SELECT id, full_path, thumb_path, caption FROM build_update_photos WHERE update_id = ? ORDER BY sort, id',
      [row.id]
    );
  }
  return rows;
}

export function getUpdate(id) {
  const row = get(
    `SELECT x.*, b.owner_id, b.slug AS build_slug, b.title AS build_title
       FROM build_updates x JOIN builds b ON b.id = x.build_id
      WHERE x.id = ?`,
    [Number(id)]
  );
  if (!row) return null;
  row.photos = all(
    'SELECT id, full_path, thumb_path, caption FROM build_update_photos WHERE update_id = ? ORDER BY sort, id',
    [row.id]
  );
  return row;
}

export function saveUpdate(buildId, fields, id = null) {
  const ts = nowIso();
  const html = renderMarkdown(fields.bodyMd);

  if (id) {
    run(
      `UPDATE build_updates
          SET title = ?, body_md = ?, body_html = ?, hours = ?, status = ?,
              posted_at = ?, updated_at = ?
        WHERE id = ?`,
      [fields.title, fields.bodyMd, html, fields.hours, fields.status, fields.postedAt, ts, Number(id)]
    );
    touch(buildId);
    return Number(id);
  }

  const info = run(
    `INSERT INTO build_updates
       (build_id, author_id, title, body_md, body_html, hours, status, posted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(buildId),
      fields.authorId,
      fields.title,
      fields.bodyMd,
      html,
      fields.hours,
      fields.status,
      fields.postedAt || ts,
      ts,
      ts,
    ]
  );
  touch(buildId);
  return Number(info.lastInsertRowid);
}

export function deleteUpdate(id) {
  const photos = all(
    'SELECT full_path, thumb_path FROM build_update_photos WHERE update_id = ?',
    [Number(id)]
  );
  run('DELETE FROM build_updates WHERE id = ?', [Number(id)]);
  return photos;
}

function touch(buildId) {
  run('UPDATE builds SET updated_at = ? WHERE id = ?', [nowIso(), Number(buildId)]);
}

export function addUpdatePhoto(updateId, { fullPath, thumbPath, caption = null }) {
  const next = get(
    'SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM build_update_photos WHERE update_id = ?',
    [Number(updateId)]
  ).s;
  run(
    `INSERT INTO build_update_photos (update_id, full_path, thumb_path, caption, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [Number(updateId), fullPath, thumbPath, caption, next, nowIso()]
  );
}

export function getUpdatePhoto(id) {
  return (
    get(
      `SELECT p.*, b.owner_id, x.build_id
         FROM build_update_photos p
         JOIN build_updates x ON x.id = p.update_id
         JOIN builds b ON b.id = x.build_id
        WHERE p.id = ?`,
      [Number(id)]
    ) ?? null
  );
}

export function deleteUpdatePhoto(id) {
  run('DELETE FROM build_update_photos WHERE id = ?', [Number(id)]);
}

/* ---------------------------------------------------------------- cheers */

export function toggleCheer(buildId, userId) {
  const existing = get('SELECT 1 AS x FROM build_cheers WHERE build_id = ? AND user_id = ?', [
    Number(buildId),
    Number(userId),
  ]);
  if (existing) {
    run('DELETE FROM build_cheers WHERE build_id = ? AND user_id = ?', [
      Number(buildId),
      Number(userId),
    ]);
    return false;
  }
  run('INSERT INTO build_cheers (build_id, user_id, created_at) VALUES (?, ?, ?)', [
    Number(buildId),
    Number(userId),
    nowIso(),
  ]);
  return true;
}

export function cheerInfo(buildId, userId = null) {
  return {
    count: get('SELECT COUNT(*) AS n FROM build_cheers WHERE build_id = ?', [Number(buildId)]).n,
    mine: userId
      ? Boolean(get('SELECT 1 AS x FROM build_cheers WHERE build_id = ? AND user_id = ?', [
          Number(buildId),
          Number(userId),
        ]))
      : false,
  };
}

/* ----------------------------------------------------------------- stats */

export function buildStats({ viewer = null } = {}) {
  const visClause = viewer ? '' : "WHERE visibility = 'public'";
  return {
    projects: get(`SELECT COUNT(*) AS n FROM builds ${visClause}`).n,
    flying: get(
      `SELECT COUNT(*) AS n FROM builds ${visClause ? `${visClause} AND` : 'WHERE'} status = 'flying'`
    ).n,
    updates: get(
      `SELECT COUNT(*) AS n FROM build_updates x
         JOIN builds b ON b.id = x.build_id
        WHERE x.status = 'published' ${viewer ? '' : "AND b.visibility = 'public'"}`
    ).n,
    hours: Math.round(
      get(
        `SELECT COALESCE(SUM(x.hours), 0) AS n FROM build_updates x
           JOIN builds b ON b.id = x.build_id
          WHERE x.status = 'published' ${viewer ? '' : "AND b.visibility = 'public'"}`
      ).n
    ),
  };
}

export function buildTotals(buildId) {
  return get(
    `SELECT COUNT(*) AS entries, COALESCE(SUM(hours), 0) AS hours
       FROM build_updates WHERE build_id = ? AND status = 'published'`,
    [Number(buildId)]
  );
}
