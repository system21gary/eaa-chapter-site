import { all, get, run, transaction, nowIso } from '../db/index.js';
import { renderMarkdown, excerpt } from '../lib/markdown.js';
import { slugify } from '../lib/validate.js';

const LIST_COLUMNS = `
  p.id, p.slug, p.title, p.summary, p.cover_path, p.cover_alt, p.status,
  p.visibility, p.pinned, p.published_at, p.created_at, p.updated_at,
  u.first_name AS author_first, u.last_name AS author_last,
  u.display_name AS author_display, u.avatar_path AS author_avatar
`;

function uniqueSlug(title, excludeId = null) {
  const base = slugify(title);
  let candidate = base;
  let n = 2;
  for (;;) {
    const clash = get('SELECT id FROM posts WHERE slug = ? AND id IS NOT ?', [
      candidate,
      excludeId,
    ]);
    if (!clash) return candidate;
    candidate = `${base}-${n++}`;
  }
}

/**
 * Visibility is enforced in SQL, not in the template. A post marked
 * `members` can never be selected by a public query, so a template bug cannot
 * leak it.
 */
export function listPosts({ viewer = null, tag = null, limit = 20, offset = 0, includeDrafts = false } = {}) {
  const where = [];
  const params = [];

  if (!viewer) {
    where.push("p.status = 'published' AND p.visibility = 'public'");
  } else if (includeDrafts && (viewer.role === 'editor' || viewer.role === 'admin')) {
    where.push("p.status IN ('published','draft')");
  } else {
    where.push("p.status = 'published'");
  }

  if (tag) {
    where.push('EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)');
    params.push(tag);
  }

  params.push(Math.min(Number(limit) || 20, 100), Math.max(Number(offset) || 0, 0));

  return all(
    `SELECT ${LIST_COLUMNS},
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'visible') AS comment_count
       FROM posts p
       LEFT JOIN users u ON u.id = p.author_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.pinned DESC, COALESCE(p.published_at, p.created_at) DESC
      LIMIT ? OFFSET ?`,
    params
  );
}

export function countPosts({ viewer = null, tag = null } = {}) {
  const where = viewer
    ? ["p.status = 'published'"]
    : ["p.status = 'published' AND p.visibility = 'public'"];
  const params = [];
  if (tag) {
    where.push('EXISTS (SELECT 1 FROM post_tags t WHERE t.post_id = p.id AND t.tag = ?)');
    params.push(tag);
  }
  return get(`SELECT COUNT(*) AS n FROM posts p WHERE ${where.join(' AND ')}`, params).n;
}

export function getPostBySlug(slug, { viewer = null } = {}) {
  const post = get(
    `SELECT p.*,
            u.first_name  AS author_first,
            u.last_name   AS author_last,
            u.display_name AS author_display,
            u.avatar_path AS author_avatar
       FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.slug = ?`,
    [slug]
  );
  if (!post) return null;

  const isStaff = viewer && (viewer.role === 'editor' || viewer.role === 'admin');
  if (post.status !== 'published' && !isStaff) return null;
  if (post.visibility === 'members' && !viewer) return null;

  post.tags = all('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY tag', [post.id]).map(
    (r) => r.tag
  );
  return post;
}

export function getPostById(id) {
  const post = get('SELECT * FROM posts WHERE id = ?', [Number(id)]);
  if (!post) return null;
  post.tags = all('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY tag', [post.id]).map(
    (r) => r.tag
  );
  return post;
}

export function createPost({
  title,
  summary,
  bodyMd,
  authorId,
  status = 'draft',
  visibility = 'members',
  tags = [],
  coverPath = null,
  coverAlt = null,
  pinned = 0,
}) {
  const ts = nowIso();
  const slug = uniqueSlug(title);
  const html = renderMarkdown(bodyMd);
  const auto = summary || excerpt(bodyMd, 180);

  return transaction(() => {
    const info = run(
      `INSERT INTO posts
         (slug, title, summary, body_md, body_html, cover_path, cover_alt,
          author_id, status, visibility, pinned, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        title,
        auto,
        bodyMd,
        html,
        coverPath,
        coverAlt,
        authorId,
        status,
        visibility,
        pinned ? 1 : 0,
        status === 'published' ? ts : null,
        ts,
        ts,
      ]
    );
    const id = Number(info.lastInsertRowid);
    setTags(id, tags);
    run(
      'INSERT INTO post_revisions (post_id, title, body_md, editor_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, title, bodyMd, authorId, ts]
    );
    return id;
  });
}

export function updatePost(id, fields, editorId) {
  const existing = getPostById(id);
  if (!existing) return null;
  const ts = nowIso();
  const title = fields.title ?? existing.title;
  const bodyMd = fields.bodyMd ?? existing.body_md;
  const status = fields.status ?? existing.status;

  return transaction(() => {
    run(
      `UPDATE posts SET
         title = ?, slug = ?, summary = ?, body_md = ?, body_html = ?,
         cover_path = ?, cover_alt = ?, status = ?, visibility = ?, pinned = ?,
         published_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE published_at END,
         updated_at = ?
       WHERE id = ?`,
      [
        title,
        fields.slug ?? (title !== existing.title ? uniqueSlug(title, id) : existing.slug),
        fields.summary ?? excerpt(bodyMd, 180),
        bodyMd,
        renderMarkdown(bodyMd),
        'coverPath' in fields ? fields.coverPath : existing.cover_path,
        'coverAlt' in fields ? fields.coverAlt : existing.cover_alt,
        status,
        fields.visibility ?? existing.visibility,
        (fields.pinned ?? existing.pinned) ? 1 : 0,
        status,
        ts,
        ts,
        id,
      ]
    );
    if (fields.tags) setTags(id, fields.tags);
    if (bodyMd !== existing.body_md || title !== existing.title) {
      run(
        'INSERT INTO post_revisions (post_id, title, body_md, editor_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, title, bodyMd, editorId, ts]
      );
    }
    return id;
  });
}

export function deletePost(id) {
  run('DELETE FROM posts WHERE id = ?', [Number(id)]);
}

function setTags(postId, tags) {
  run('DELETE FROM post_tags WHERE post_id = ?', [postId]);
  for (const tag of tags.slice(0, 8)) {
    run('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)', [postId, tag]);
  }
}

export function allTags() {
  return all(
    `SELECT t.tag, COUNT(*) AS n
       FROM post_tags t JOIN posts p ON p.id = t.post_id
      WHERE p.status = 'published'
      GROUP BY t.tag ORDER BY n DESC, t.tag`
  );
}

export function revisions(postId) {
  return all(
    `SELECT r.id, r.title, r.created_at, u.first_name, u.last_name
       FROM post_revisions r LEFT JOIN users u ON u.id = r.editor_id
      WHERE r.post_id = ? ORDER BY r.id DESC LIMIT 30`,
    [Number(postId)]
  );
}

/* -------------------------------------------------------------- comments */

export function listComments(postId) {
  return all(
    `SELECT c.id, c.body, c.created_at, c.user_id,
            u.first_name, u.last_name, u.display_name, u.avatar_path
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.post_id = ? AND c.status = 'visible'
      ORDER BY c.created_at`,
    [Number(postId)]
  );
}

export function addComment(postId, userId, body) {
  const info = run(
    'INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)',
    [Number(postId), Number(userId), body, nowIso()]
  );
  return Number(info.lastInsertRowid);
}

export function hideComment(id) {
  run("UPDATE comments SET status = 'hidden' WHERE id = ?", [Number(id)]);
}

export function getComment(id) {
  return get('SELECT * FROM comments WHERE id = ?', [Number(id)]) ?? null;
}
