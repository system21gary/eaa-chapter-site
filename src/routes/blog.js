import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { normaliseRichField } from '../lib/richtext.js';
import * as Posts from '../models/posts.js';
import { requireAuth, requireEditor, canManage } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { processImage, deleteImage } from '../lib/images.js';
import { stripHtml } from '../lib/markdown.js';
import { audit } from '../lib/audit.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1 + config.uploads.maxPostPhotos, fields: 25 },
});
// One cover image, plus any number of gallery photos up to the per-post limit.
const postFiles = upload.fields([
  { name: 'cover', maxCount: 1 },
  { name: 'photos', maxCount: config.uploads.maxPostPhotos },
]);

/**
 * Processes and attaches the gallery photos from an upload. Stops at the
 * per-post limit and skips any file that is not a usable image, so one bad
 * file does not lose the rest. Returns what happened, for the flash message.
 */
async function storePhotos(postId, files) {
  const result = { added: 0, skipped: 0, overLimit: 0 };
  let slot = Posts.countPhotos(postId);
  for (const file of files ?? []) {
    if (slot >= config.uploads.maxPostPhotos) {
      result.overLimit += 1;
      continue;
    }
    try {
      const img = await processImage(file.buffer, { folder: 'postphotos' });
      Posts.addPhoto(postId, { fullPath: img.fullPath, thumbPath: img.thumbPath });
      slot += 1;
      result.added += 1;
    } catch (err) {
      console.warn(`[blog] skipped a photo for post ${postId}: ${err.message}`);
      result.skipped += 1;
    }
  }
  return result;
}

/** Upload limits the edit form shows and hands to the drop zone. */
const editLimits = {
  maxPhotos: config.uploads.maxPostPhotos,
  maxMb: Math.round(config.uploads.maxBytes / 1048576),
};

/** Ids from a repeated form field, as numbers. */
function idList(value) {
  return [].concat(value ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/** Deletes stored files that no post uses any more. */
async function releaseFiles(...relPaths) {
  for (const rel of new Set(relPaths.filter(Boolean))) {
    if (!Posts.fileInUse(rel)) await deleteImage(rel);
  }
}

/** "Post updated." plus a note about any photos that were not added. */
function photoNote(result) {
  const notes = [];
  if (result.overLimit) {
    notes.push(`${result.overLimit} not added: a post holds at most ${config.uploads.maxPostPhotos} photos`);
  }
  if (result.skipped) {
    notes.push(`${result.skipped} could not be read as an image`);
  }
  return notes.length ? ` (${notes.join('; ')}.)` : '';
}

router.use(requireAuth);

// Existing tags for the picker on the write/edit form. A getter, so the query
// only runs on the pages that actually render it.
router.use((req, res, next) => {
  Object.defineProperty(res.locals, 'knownTags', { get: () => Posts.knownTags(), enumerable: true, configurable: true });
  next();
});

/* ------------------------------------------------------------------ index */

router.get('/', (req, res) => {
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const perPage = 10;
  const tag = typeof req.query.tag === 'string' ? req.query.tag.slice(0, 40) : null;

  const posts = Posts.listPosts({
    viewer: req.user,
    tag,
    limit: perPage,
    offset: (page - 1) * perPage,
    includeDrafts: true,
  });

  res.render('members/blog-index.njk', {
    title: 'Chapter blog',
    robots: 'noindex',
    posts,
    tags: Posts.allTags(),
    activeTag: tag,
    page,
    hasNext: posts.length === perPage,
    canWrite: ['editor', 'admin'].includes(req.user.role),
  });
});

/* --------------------------------------------------------------- compose */

router.get('/new', requireEditor, (req, res) => {
  res.render('members/blog-edit.njk', {
    ...editLimits,
    title: 'New post',
    robots: 'noindex',
    post: { status: 'draft', tags: [] },
    errors: {},
    isNew: true,
  });
});

const postSchema = {
  title: f.string({ min: 4, max: 160, label: 'Title' }),
  summary: f.optionalString({ max: 300, label: 'Summary' }),
  body_md: f.string({ min: 10, max: 60000, label: 'Post body' }),
  status: f.enum(['draft', 'published', 'archived'], { label: 'Status', fallback: 'draft' }),
  cover_alt: f.optionalString({ max: 200, label: 'Cover image description' }),
  tags: f.tags(),
  pinned: f.bool(),
};

router.post(
  '/new',
  requireEditor,
  writeLimiter,
  uploadLimiter,
  postFiles,
  verifyMultipartCsrf,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(normaliseRichField(req.body, 'body_md'), postSchema);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/blog-edit.njk', {
          ...editLimits,
          title: 'New post',
          robots: 'noindex',
          post: { ...req.body, tags: String(req.body.tags ?? '').split(',') },
          errors: err.errors,
          isNew: true,
        });
      }
      throw err;
    }

    let coverPath = null;
    const cover = req.files?.cover?.[0];
    if (cover) {
      const img = await processImage(cover.buffer, { folder: 'posts' });
      coverPath = img.fullPath;
    }

    const id = Posts.createPost({
      title: data.title,
      summary: data.summary,
      bodyMd: data.body_md,
      authorId: req.user.id,
      status: data.status,
      tags: data.tags,
      coverPath,
      coverAlt: data.cover_alt,
      pinned: data.pinned,
    });

    const photos = await storePhotos(id, req.files?.photos);
    audit(req, 'blog.post.created', { entity: 'post', entityId: id, detail: data.title });
    req.flash(
      photos.skipped || photos.overLimit ? 'error' : 'success',
      (data.status === 'published' ? 'Post published.' : 'Draft saved.') + photoNote(photos)
    );
    const post = Posts.getPostById(id);
    return req.session.save(() => res.redirect(`/members/blog/${post.slug}`));
  })
);

/* ----------------------------------------------------------------- detail */

router.get('/:slug', (req, res, next) => {
  const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
  if (!post) return next();
  res.render('members/blog-post.njk', {
    title: post.title,
    robots: 'noindex',
    post,
    comments: Posts.listComments(post.id),
    canEdit: canManage(req.user, post.author_id) || req.user.role === 'editor',
  });
});

router.get('/:slug/edit', requireEditor, (req, res, next) => {
  const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
  if (!post) return next();
  res.render('members/blog-edit.njk', {
    ...editLimits,
    title: `Edit: ${post.title}`,
    robots: 'noindex',
    post,
    errors: {},
    isNew: false,
    revisions: Posts.revisions(post.id),
  });
});

router.post(
  '/:slug/edit',
  requireEditor,
  writeLimiter,
  uploadLimiter,
  postFiles,
  verifyMultipartCsrf,
  asyncRoute(async (req, res, next) => {
    const existing = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
    if (!existing) return next();

    let data;
    try {
      data = validate(normaliseRichField(req.body, 'body_md'), postSchema);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/blog-edit.njk', {
          ...editLimits,
          title: `Edit: ${existing.title}`,
          robots: 'noindex',
          post: { ...existing, ...req.body, tags: String(req.body.tags ?? '').split(',') },
          errors: err.errors,
          isNew: false,
        });
      }
      throw err;
    }

    const fields = {
      title: data.title,
      summary: data.summary,
      bodyMd: data.body_md,
      status: data.status,
      tags: data.tags,
      coverAlt: data.cover_alt,
      pinned: data.pinned,
    };

    const cover = req.files?.cover?.[0];
    if (cover) {
      const img = await processImage(cover.buffer, { folder: 'posts' });
      fields.coverPath = img.fullPath;
    }

    Posts.updatePost(existing.id, fields, req.user.id);
    if ('coverPath' in fields) await releaseFiles(existing.cover_path);
    const photos = await storePhotos(existing.id, req.files?.photos);
    audit(req, 'blog.post.updated', { entity: 'post', entityId: existing.id });
    req.flash(photos.skipped || photos.overLimit ? 'error' : 'success', `Post updated.${photoNote(photos)}`);
    const fresh = Posts.getPostById(existing.id);
    return req.session.save(() => res.redirect(`/members/blog/${fresh.slug}`));
  })
);

router.post('/:slug/delete', requireEditor, writeLimiter, asyncRoute(async (req, res, next) => {
  const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
  if (!post) return next();
  if (post.cover_path) await deleteImage(post.cover_path);
  await deleteImage(...post.photos.flatMap((p) => [p.full_path, p.thumb_path]));
  Posts.deletePost(post.id);
  audit(req, 'blog.post.deleted', { entity: 'post', entityId: post.id, detail: post.title });
  req.flash('success', 'Post deleted.');
  return req.session.save(() => res.redirect('/members/blog'));
}));

/* ------------------------------------------- photo actions (immediate) --
   The edit page's tiles act straight away, in the background, rather than on
   Save: reorder, make a photo the cover, delete a photo. Each answers JSON. */

function photoAction(handler) {
  return [
    requireEditor,
    writeLimiter,
    asyncRoute(async (req, res, next) => {
      try {
        const out = await handler(req);
        if (out === null) return next();
        return res.json({ ok: true, ...out });
      } catch (err) {
        if (err.status && err.status < 500) return res.status(err.status).json({ ok: false, message: err.message });
        throw err;
      }
    }),
  ];
}

router.post(
  '/:slug/photos/order',
  ...photoAction(async (req) => {
    const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
    if (!post) return null;
    Posts.reorderPhotos(post.id, idList(String(req.body.order ?? '').split(',')));
    return { message: 'Order saved.' };
  })
);

router.post(
  '/photos/:id/cover',
  ...photoAction(async (req) => {
    const photo = Posts.getPhoto(req.params.id);
    if (!photo) return null;
    const post = Posts.getPostById(photo.post_id);
    const previous = post.cover_path;
    Posts.setCover(post.id, photo.full_path);
    await releaseFiles(previous);
    audit(req, 'blog.cover.set', { entity: 'post', entityId: post.id });
    return { message: 'Cover image set.' };
  })
);

router.post(
  '/photos/:id/delete',
  ...photoAction(async (req) => {
    const photo = Posts.getPhoto(req.params.id);
    if (!photo) return null;
    const post = Posts.getPostById(photo.post_id);
    const wasCover = post.cover_path === photo.full_path;
    Posts.deletePhoto(photo.id);
    if (wasCover) Posts.setCover(post.id, null);
    await releaseFiles(photo.full_path, photo.thumb_path);
    audit(req, 'blog.photo.removed', { entity: 'post', entityId: post.id });
    return { message: 'Photo deleted.', coverCleared: wasCover };
  })
);

/* --------------------------------------------------------------- comments */

router.post(
  '/:slug/comments',
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
    if (!post) return next();

    let data;
    try {
      data = validate(req.body, { body: f.string({ min: 2, max: 2000, label: 'Comment' }) });
    } catch (err) {
      if (err instanceof ValidationError) {
        req.flash('error', Object.values(err.errors)[0]);
        return req.session.save(() => res.redirect(`/members/blog/${post.slug}`));
      }
      throw err;
    }

    // Comments never render markup -- they are stored and displayed as plain
    // text, so there is no sanitiser to get wrong.
    Posts.addComment(post.id, req.user.id, stripHtml(data.body));
    audit(req, 'blog.comment.added', { entity: 'post', entityId: post.id });
    return req.session.save(() => res.redirect(`/members/blog/${post.slug}#comments`));
  })
);

router.post('/comments/:id/hide', writeLimiter, (req, res, next) => {
  const comment = Posts.getComment(req.params.id);
  if (!comment) return next();
  if (!canManage(req.user, comment.user_id) && !['editor', 'admin'].includes(req.user.role)) {
    const err = new Error('You can only remove your own comments.');
    err.status = 403;
    return next(err);
  }
  Posts.hideComment(comment.id);
  audit(req, 'blog.comment.hidden', { entity: 'comment', entityId: comment.id });
  req.flash('success', 'Comment removed.');
  // Redirect to a path we derive ourselves rather than echoing the Referer
  // header, which a third-party page could point anywhere.
  const post = Posts.getPostById(comment.post_id);
  return req.session.save(() =>
    res.redirect(post ? `/members/blog/${post.slug}#comments` : '/members/blog')
  );
});

export default router;
