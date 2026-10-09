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
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 25 },
});

router.use(requireAuth);

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
    title: 'New post',
    robots: 'noindex',
    post: { status: 'draft', visibility: 'members', tags: [] },
    errors: {},
    isNew: true,
  });
});

const postSchema = {
  title: f.string({ min: 4, max: 160, label: 'Title' }),
  summary: f.optionalString({ max: 300, label: 'Summary' }),
  body_md: f.string({ min: 10, max: 60000, label: 'Post body' }),
  status: f.enum(['draft', 'published', 'archived'], { label: 'Status', fallback: 'draft' }),
  visibility: f.enum(['members', 'public'], { label: 'Visibility', fallback: 'members' }),
  cover_alt: f.optionalString({ max: 200, label: 'Cover image description' }),
  tags: f.tags(),
  pinned: f.bool(),
};

router.post(
  '/new',
  requireEditor,
  writeLimiter,
  uploadLimiter,
  upload.single('cover'),
  verifyMultipartCsrf,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(normaliseRichField(req.body, 'body_md'), postSchema);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/blog-edit.njk', {
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
    if (req.file) {
      const img = await processImage(req.file.buffer, { folder: 'posts' });
      coverPath = img.fullPath;
    }

    const id = Posts.createPost({
      title: data.title,
      summary: data.summary,
      bodyMd: data.body_md,
      authorId: req.user.id,
      status: data.status,
      visibility: data.visibility,
      tags: data.tags,
      coverPath,
      coverAlt: data.cover_alt,
      pinned: data.pinned,
    });

    audit(req, 'blog.post.created', { entity: 'post', entityId: id, detail: data.title });
    req.flash('success', data.status === 'published' ? 'Post published.' : 'Draft saved.');
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
  upload.single('cover'),
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
      visibility: data.visibility,
      tags: data.tags,
      coverAlt: data.cover_alt,
      pinned: data.pinned,
    };

    if (req.file) {
      const img = await processImage(req.file.buffer, { folder: 'posts' });
      fields.coverPath = img.fullPath;
      if (existing.cover_path) await deleteImage(existing.cover_path);
    }

    Posts.updatePost(existing.id, fields, req.user.id);
    audit(req, 'blog.post.updated', { entity: 'post', entityId: existing.id });
    req.flash('success', 'Post updated.');
    const fresh = Posts.getPostById(existing.id);
    return req.session.save(() => res.redirect(`/members/blog/${fresh.slug}`));
  })
);

router.post('/:slug/delete', requireEditor, writeLimiter, asyncRoute(async (req, res, next) => {
  const post = Posts.getPostBySlug(req.params.slug, { viewer: req.user });
  if (!post) return next();
  if (post.cover_path) await deleteImage(post.cover_path);
  Posts.deletePost(post.id);
  audit(req, 'blog.post.deleted', { entity: 'post', entityId: post.id, detail: post.title });
  req.flash('success', 'Post deleted.');
  return req.session.save(() => res.redirect('/members/blog'));
}));

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
