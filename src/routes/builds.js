import express from 'express';
import * as Builds from '../models/builds.js';

const router = express.Router();

/**
 * Public shop-window for members' aircraft projects.
 *
 * Anonymous visitors see only projects the owner marked public, and only
 * published log entries. The filtering happens in the model's SQL, so this
 * layer stays simple.
 */

router.get('/', (req, res) => {
  const status = Builds.BUILD_STATUSES.includes(req.query.status) ? req.query.status : null;
  const kind = Builds.BUILD_KINDS.includes(req.query.kind) ? req.query.kind : null;

  const builds = Builds.listBuilds({ viewer: req.user, status, kind });

  res.render('pages/builds.njk', {
    title: "Members' builds",
    metaDescription:
      'Aircraft projects under construction and restoration by members of EAA Chapter 1699 at South Albany Airport (4B0) — build logs, photos and progress.',
    builds,
    stats: Builds.buildStats({ viewer: req.user }),
    statuses: Builds.BUILD_STATUSES,
    kinds: Builds.BUILD_KINDS,
    statusLabels: Builds.STATUS_LABELS,
    kindLabels: Builds.KIND_LABELS,
    activeStatus: status,
    activeKind: kind,
  });
});

router.get('/:slug', (req, res, next) => {
  const build = Builds.getBuildBySlug(req.params.slug, { viewer: req.user });
  if (!build) return next();

  const isOwner = req.user && Number(req.user.id) === Number(build.owner_id);
  const canManage = isOwner || req.user?.role === 'admin';

  res.render('pages/build-detail.njk', {
    title: build.title,
    metaDescription: build.summary,
    ogImage: build.cover_path ? `/media/${build.cover_path}` : null,
    build,
    // Drafts are visible to the owner (and admins) so they can preview.
    updates: Builds.listUpdates(build.id, { viewer: canManage }),
    totals: Builds.buildTotals(build.id),
    cheers: Builds.cheerInfo(build.id, req.user?.id),
    statusLabels: Builds.STATUS_LABELS,
    kindLabels: Builds.KIND_LABELS,
    canManage,
    others: Builds.listBuilds({ viewer: req.user, limit: 6 }).filter((b) => b.id !== build.id).slice(0, 3),
  });
});

/** Encouragement from a signed-in member. Anonymous visitors just see the count. */
router.post('/:slug/cheer', (req, res, next) => {
  if (!req.user) {
    const err = new Error('Sign in to cheer on a project.');
    err.status = 403;
    return next(err);
  }
  const build = Builds.getBuildBySlug(req.params.slug, { viewer: req.user });
  if (!build) return next();
  Builds.toggleCheer(build.id, req.user.id);
  return res.redirect(`/builds/${build.slug}#cheer`);
});

export default router;
