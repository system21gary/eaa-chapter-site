import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { normaliseRichField } from '../lib/richtext.js';
import * as Builds from '../models/builds.js';
import { requireAuth, canManage } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { processImage, deleteImage } from '../lib/images.js';
import { audit } from '../lib/audit.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 10, fields: 40 },
});

router.use(requireAuth);

const buildSchema = {
  title: f.string({ min: 3, max: 120, label: 'Project name' }),
  aircraft_type: f.string({ min: 2, max: 100, label: 'Aircraft type' }),
  tail_number: f.optionalString({ max: 12, label: 'Registration' }),
  build_kind: f.enum(Builds.BUILD_KINDS, { label: 'Project type', fallback: 'kit' }),
  status: f.enum(Builds.BUILD_STATUSES, { label: 'Status', fallback: 'building' }),
  percent_complete: f.int({ min: 0, max: 100, optional: true, label: 'Percent complete' }),
  started_on: f.datetime({ label: 'Started' }),
  first_flight_on: f.datetime({ label: 'First flight' }),
  engine: f.optionalString({ max: 120, label: 'Engine' }),
  panel: f.optionalString({ max: 200, label: 'Panel' }),
  hangar: f.optionalString({ max: 120, label: 'Where it lives' }),
  summary: f.optionalString({ max: 300, label: 'One-line summary' }),
  body_md: f.optionalString({ max: 30000, label: 'About this project' }),
  cover_alt: f.optionalString({ max: 200, label: 'Cover photo description' }),
  external_log_url: f.url({ label: 'External build log' }),
  visibility: f.enum(['public', 'members'], { label: 'Visibility', fallback: 'public' }),
};

function ownerGuard(req, build, next) {
  if (!canManage(req.user, build.owner_id)) {
    const err = new Error('Only the member who owns this project can change it.');
    err.status = 403;
    next(err);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------- my projects */

router.get('/', (req, res) => {
  res.render('members/builds.njk', {
    title: 'Your projects',
    robots: 'noindex',
    builds: Builds.listBuilds({ viewer: req.user, ownerId: req.user.id }),
    statusLabels: Builds.STATUS_LABELS,
    kindLabels: Builds.KIND_LABELS,
  });
});

/* ------------------------------------------------------------------ create */

router.get('/new', (req, res) => {
  res.render('members/build-edit.njk', {
    title: 'Start a build log',
    robots: 'noindex',
    build: {
      status: 'building',
      build_kind: 'kit',
      visibility: 'public',
      percent_complete: 0,
      hangar: req.user.home_base || 'South Albany Airport (4B0)',
    },
    kinds: Builds.BUILD_KINDS,
    statuses: Builds.BUILD_STATUSES,
    statusLabels: Builds.STATUS_LABELS,
    kindLabels: Builds.KIND_LABELS,
    errors: {},
    isNew: true,
  });
});

async function saveBuildHandler(req, res, next) {
  const id = req.params.id ? Number(req.params.id) : null;
  const existing = id ? Builds.getBuildById(id) : null;
  if (id && !existing) return next();
  if (existing && !ownerGuard(req, existing, next)) return undefined;

  let data;
  try {
    data = validate(normaliseRichField(req.body, 'body_md'), buildSchema);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).render('members/build-edit.njk', {
        title: id ? 'Edit project' : 'Start a build log',
        robots: 'noindex',
        build: { ...(existing ?? {}), ...req.body },
        kinds: Builds.BUILD_KINDS,
        statuses: Builds.BUILD_STATUSES,
        statusLabels: Builds.STATUS_LABELS,
        kindLabels: Builds.KIND_LABELS,
        errors: err.errors,
        isNew: !id,
      });
    }
    throw err;
  }

  const fields = {
    // owner_id is taken from the session on create and never re-read from the
    // form, so a project cannot be reassigned by editing a hidden input.
    ownerId: existing ? existing.owner_id : req.user.id,
    title: data.title,
    aircraftType: data.aircraft_type,
    tailNumber: data.tail_number,
    buildKind: data.build_kind,
    status: data.status,
    percentComplete: data.percent_complete ?? 0,
    startedOn: data.started_on,
    firstFlightOn: data.first_flight_on,
    engine: data.engine,
    panel: data.panel,
    hangar: data.hangar,
    summary: data.summary,
    bodyMd: data.body_md,
    coverAlt: data.cover_alt,
    externalLogUrl: data.external_log_url,
    visibility: data.visibility,
  };

  if (req.file) {
    const img = await processImage(req.file.buffer, { folder: 'builds' });
    fields.coverPath = img.fullPath;
    if (existing?.cover_path) await deleteImage(existing.cover_path);
  }

  const buildId = Builds.saveBuild(fields, id);
  const saved = Builds.getBuildById(buildId);

  audit(req, id ? 'build.updated' : 'build.created', {
    entity: 'build',
    entityId: buildId,
    detail: data.title,
  });
  req.flash('success', id ? 'Project updated.' : 'Build log started — now post your first update.');
  return req.session.save(() =>
    res.redirect(id ? `/builds/${saved.slug}` : `/members/builds/${buildId}/updates/new`)
  );
}

router.post(
  '/new',
  writeLimiter,
  uploadLimiter,
  upload.single('cover'),
  verifyMultipartCsrf,
  asyncRoute(saveBuildHandler)
);

router.get('/:id/edit', (req, res, next) => {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;

  return res.render('members/build-edit.njk', {
    title: `Edit: ${build.title}`,
    robots: 'noindex',
    build,
    kinds: Builds.BUILD_KINDS,
    statuses: Builds.BUILD_STATUSES,
    statusLabels: Builds.STATUS_LABELS,
    kindLabels: Builds.KIND_LABELS,
    errors: {},
    isNew: false,
  });
});

router.post(
  '/:id/edit',
  writeLimiter,
  uploadLimiter,
  upload.single('cover'),
  verifyMultipartCsrf,
  asyncRoute(saveBuildHandler)
);

router.post('/:id/delete', writeLimiter, asyncRoute(async (req, res, next) => {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;

  const photos = Builds.deleteBuild(build.id);
  await deleteImage(build.cover_path, ...photos.flatMap((p) => [p.full_path, p.thumb_path]));
  audit(req, 'build.deleted', { entity: 'build', entityId: build.id, detail: build.title });
  req.flash('success', 'Project removed.');
  return req.session.save(() => res.redirect('/members/builds'));
}));

/* -------------------------------------------------------------- log entries */

const updateSchema = {
  title: f.string({ min: 3, max: 140, label: 'Entry title' }),
  body_md: f.string({ min: 5, max: 30000, label: 'What you did' }),
  hours: f.float({ min: 0, max: 10000, label: 'Hours' }),
  posted_at: f.datetime({ label: 'Date' }),
  status: f.enum(['draft', 'published'], { label: 'Status', fallback: 'published' }),
};

router.get('/:id/updates/new', (req, res, next) => {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;

  return res.render('members/build-update-edit.njk', {
    title: `New entry · ${build.title}`,
    robots: 'noindex',
    build,
    entry: { status: 'published' },
    errors: {},
    isNew: true,
  });
});

async function saveUpdateHandler(req, res, next) {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;

  const updateId = req.params.updateId ? Number(req.params.updateId) : null;
  const existing = updateId ? Builds.getUpdate(updateId) : null;
  if (updateId && (!existing || Number(existing.build_id) !== Number(build.id))) return next();

  let data;
  try {
    data = validate(normaliseRichField(req.body, 'body_md'), updateSchema);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).render('members/build-update-edit.njk', {
        title: `Entry · ${build.title}`,
        robots: 'noindex',
        build,
        entry: { ...(existing ?? {}), ...req.body },
        errors: err.errors,
        isNew: !updateId,
      });
    }
    throw err;
  }

  const savedId = Builds.saveUpdate(
    build.id,
    {
      authorId: req.user.id,
      title: data.title,
      bodyMd: data.body_md,
      hours: data.hours,
      status: data.status,
      postedAt: data.posted_at,
    },
    updateId
  );

  const captions = [].concat(req.body.caption ?? []);
  for (const [i, file] of (req.files ?? []).entries()) {
    try {
      const img = await processImage(file.buffer, { folder: 'builds' });
      Builds.addUpdatePhoto(savedId, {
        fullPath: img.fullPath,
        thumbPath: img.thumbPath,
        caption: String(captions[i] ?? '').slice(0, 200) || null,
      });
    } catch (err) {
      console.warn(`[builds] skipped a photo on entry ${savedId}: ${err.message}`);
    }
  }

  audit(req, updateId ? 'build.update.edited' : 'build.update.posted', {
    entity: 'build_update',
    entityId: savedId,
  });
  req.flash('success', data.status === 'draft' ? 'Draft saved.' : 'Log entry posted.');
  return req.session.save(() => res.redirect(`/builds/${build.slug}`));
}

router.post(
  '/:id/updates/new',
  writeLimiter,
  uploadLimiter,
  upload.array('photos', 10),
  verifyMultipartCsrf,
  asyncRoute(saveUpdateHandler)
);

router.get('/:id/updates/:updateId/edit', (req, res, next) => {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;
  const entry = Builds.getUpdate(req.params.updateId);
  if (!entry || Number(entry.build_id) !== Number(build.id)) return next();

  return res.render('members/build-update-edit.njk', {
    title: `Edit entry · ${build.title}`,
    robots: 'noindex',
    build,
    entry,
    errors: {},
    isNew: false,
  });
});

router.post(
  '/:id/updates/:updateId/edit',
  writeLimiter,
  uploadLimiter,
  upload.array('photos', 10),
  verifyMultipartCsrf,
  asyncRoute(saveUpdateHandler)
);

router.post('/:id/updates/:updateId/delete', writeLimiter, asyncRoute(async (req, res, next) => {
  const build = Builds.getBuildById(req.params.id);
  if (!build) return next();
  if (!ownerGuard(req, build, next)) return undefined;
  const entry = Builds.getUpdate(req.params.updateId);
  if (!entry || Number(entry.build_id) !== Number(build.id)) return next();

  const photos = Builds.deleteUpdate(entry.id);
  await deleteImage(...photos.flatMap((p) => [p.full_path, p.thumb_path]));
  audit(req, 'build.update.deleted', { entity: 'build_update', entityId: entry.id });
  req.flash('success', 'Log entry deleted.');
  return req.session.save(() => res.redirect(`/builds/${build.slug}`));
}));

router.post('/photos/:photoId/delete', writeLimiter, asyncRoute(async (req, res, next) => {
  const photo = Builds.getUpdatePhoto(req.params.photoId);
  if (!photo) return next();
  if (!canManage(req.user, photo.owner_id)) {
    const err = new Error('That is not your photo to remove.');
    err.status = 403;
    return next(err);
  }
  Builds.deleteUpdatePhoto(photo.id);
  await deleteImage(photo.full_path, photo.thumb_path);
  req.flash('success', 'Photo removed.');
  return req.session.save(() =>
    res.redirect(`/members/builds/${photo.build_id}/updates/${photo.update_id}/edit`)
  );
}));

export default router;
