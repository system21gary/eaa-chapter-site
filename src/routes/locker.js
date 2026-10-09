import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { normaliseRichField } from '../lib/richtext.js';
import { absoluteUrl } from '../middleware/base-path.js';
import * as Tools from '../models/tools.js';
import * as Users from '../models/users.js';
import { requireAuth, canManage } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { processImage, deleteImage } from '../lib/images.js';
import { stripHtml } from '../lib/markdown.js';
import {
  sendMail,
  borrowRequestEmail,
  borrowDecisionEmail,
} from '../lib/mailer.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.uploads.maxBytes,
    files: config.uploads.maxFilesPerTool,
    fields: 30,
  },
});

router.use(requireAuth);

const CONDITIONS = ['excellent', 'good', 'fair', 'needs-tlc'];
const AVAILABILITY = ['available', 'on-loan', 'unavailable'];

const toolSchema = {
  name: f.string({ min: 2, max: 120, label: 'Tool name' }),
  brand: f.optionalString({ max: 60, label: 'Brand' }),
  model: f.optionalString({ max: 60, label: 'Model' }),
  description: f.optionalString({ max: 4000, label: 'Description' }),
  condition: f.enum(CONDITIONS, { label: 'Condition', fallback: 'good' }),
  availability: f.enum(AVAILABILITY, { label: 'Availability', fallback: 'available' }),
  category_id: f.int({ min: 1, optional: true, label: 'Category' }),
  location_label: f.optionalString({ max: 120, label: 'Where it lives' }),
  location_notes: f.optionalString({ max: 500, label: 'Location notes' }),
  latitude: f.float({ min: -90, max: 90, label: 'Latitude' }),
  longitude: f.float({ min: -180, max: 180, label: 'Longitude' }),
  loan_terms: f.optionalString({ max: 1000, label: 'Lending terms' }),
  deposit: f.optionalString({ max: 80, label: 'Deposit' }),
  manual_url: f.url({ label: 'Manual link' }),
  requires_checkout: f.bool(),
};

/* ------------------------------------------------------------------ index */

router.get('/', (req, res) => {
  const filters = {
    category: typeof req.query.category === 'string' ? req.query.category.slice(0, 40) : null,
    availability: AVAILABILITY.includes(req.query.availability) ? req.query.availability : null,
    search: typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : null,
    ownerId: req.query.mine === '1' ? req.user.id : null,
  };

  res.render('members/locker-index.njk', {
    title: 'Tool Locker',
    robots: 'noindex',
    tools: Tools.listTools(filters),
    categories: Tools.listCategories(),
    filters: { ...filters, q: filters.search },
    stats: Tools.lockerStats(),
    pendingCount: Tools.pendingRequestCount(req.user.id),
    conditions: CONDITIONS,
  });
});

/* ----------------------------------------------------------------- create */

router.get('/new', (req, res) => {
  res.render('members/locker-edit.njk', {
    title: 'Add a tool',
    robots: 'noindex',
    tool: {
      condition: 'good',
      availability: 'available',
      location_label: req.user.home_base || 'South Albany Airport (4B0)',
      latitude: config.site.airport.latitude,
      longitude: config.site.airport.longitude,
      images: [],
    },
    categories: Tools.listCategories(),
    conditions: CONDITIONS,
    availabilities: AVAILABILITY,
    errors: {},
    isNew: true,
  });
});

router.post(
  '/new',
  writeLimiter,
  uploadLimiter,
  upload.array('photos', config.uploads.maxFilesPerTool),
  verifyMultipartCsrf,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(normaliseRichField(req.body, 'description'), toolSchema);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/locker-edit.njk', {
          title: 'Add a tool',
          robots: 'noindex',
          tool: { ...req.body, images: [] },
          categories: Tools.listCategories(),
          conditions: CONDITIONS,
          availabilities: AVAILABILITY,
          errors: err.errors,
          isNew: true,
        });
      }
      throw err;
    }

    // owner_id comes from the session, never from the form -- a member cannot
    // list a tool under someone else's name.
    const toolId = Tools.createTool({
      ownerId: req.user.id,
      categoryId: data.category_id,
      name: data.name,
      brand: data.brand,
      model: data.model,
      description: data.description,
      condition: data.condition,
      availability: data.availability,
      locationLabel: data.location_label,
      locationNotes: data.location_notes,
      latitude: data.latitude,
      longitude: data.longitude,
      loanTerms: data.loan_terms,
      requiresCheckout: data.requires_checkout,
      deposit: data.deposit,
      manualUrl: data.manual_url,
    });

    await storePhotos(toolId, req.files, req.body);

    audit(req, 'locker.tool.created', { entity: 'tool', entityId: toolId, detail: data.name });
    req.flash('success', `“${data.name}” is in the locker.`);
    return req.session.save(() => res.redirect(`/members/locker/${toolId}`));
  })
);

/* ------------------------------------------------------------ my requests */

router.get('/requests', (req, res) => {
  res.render('members/locker-requests.njk', {
    title: 'Borrow requests',
    robots: 'noindex',
    inbox: Tools.requestsForOwner(req.user.id),
    outbox: Tools.requestsByRequester(req.user.id),
  });
});

/* ----------------------------------------------------------------- detail */

router.get('/:id', (req, res, next) => {
  const tool = Tools.getTool(req.params.id);
  if (!tool) return next();
  res.render('members/locker-tool.njk', {
    title: tool.name,
    robots: 'noindex',
    tool,
    isOwner: Number(tool.owner_id) === Number(req.user.id),
    canEdit: canManage(req.user, tool.owner_id),
    alreadyRequested: Tools.hasOpenRequest(tool.id, req.user.id),
    requests: canManage(req.user, tool.owner_id)
      ? Tools.requestsForOwner(req.user.id).filter((r) => r.tool_id === tool.id)
      : [],
  });
});

router.get('/:id/edit', (req, res, next) => {
  const tool = Tools.getTool(req.params.id);
  if (!tool) return next();
  if (!canManage(req.user, tool.owner_id)) {
    const err = new Error('Only the member who listed this tool can edit it.');
    err.status = 403;
    return next(err);
  }
  res.render('members/locker-edit.njk', {
    title: `Edit: ${tool.name}`,
    robots: 'noindex',
    tool,
    categories: Tools.listCategories(),
    conditions: CONDITIONS,
    availabilities: AVAILABILITY,
    errors: {},
    isNew: false,
  });
});

router.post(
  '/:id/edit',
  writeLimiter,
  uploadLimiter,
  upload.array('photos', config.uploads.maxFilesPerTool),
  verifyMultipartCsrf,
  asyncRoute(async (req, res, next) => {
    const tool = Tools.getTool(req.params.id);
    if (!tool) return next();
    if (!canManage(req.user, tool.owner_id)) {
      const err = new Error('Only the member who listed this tool can edit it.');
      err.status = 403;
      return next(err);
    }

    let data;
    try {
      data = validate(normaliseRichField(req.body, 'description'), toolSchema);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/locker-edit.njk', {
          title: `Edit: ${tool.name}`,
          robots: 'noindex',
          tool: { ...tool, ...req.body },
          categories: Tools.listCategories(),
          conditions: CONDITIONS,
          availabilities: AVAILABILITY,
          errors: err.errors,
          isNew: false,
        });
      }
      throw err;
    }

    Tools.updateTool(tool.id, {
      categoryId: data.category_id,
      name: data.name,
      brand: data.brand,
      model: data.model,
      description: data.description,
      condition: data.condition,
      availability: data.availability,
      locationLabel: data.location_label,
      locationNotes: data.location_notes,
      latitude: data.latitude,
      longitude: data.longitude,
      loanTerms: data.loan_terms,
      requiresCheckout: data.requires_checkout,
      deposit: data.deposit,
      manualUrl: data.manual_url,
    });

    await storePhotos(tool.id, req.files, req.body);

    audit(req, 'locker.tool.updated', { entity: 'tool', entityId: tool.id });
    req.flash('success', 'Tool updated.');
    return req.session.save(() => res.redirect(`/members/locker/${tool.id}`));
  })
);

router.post('/:id/delete', writeLimiter, asyncRoute(async (req, res, next) => {
  const tool = Tools.getTool(req.params.id);
  if (!tool) return next();
  if (!canManage(req.user, tool.owner_id)) {
    const err = new Error('Only the member who listed this tool can remove it.');
    err.status = 403;
    return next(err);
  }
  const images = Tools.deleteTool(tool.id);
  await deleteImage(...images.flatMap((i) => [i.full_path, i.thumb_path]));
  audit(req, 'locker.tool.deleted', { entity: 'tool', entityId: tool.id, detail: tool.name });
  req.flash('success', `“${tool.name}” removed from the locker.`);
  return req.session.save(() => res.redirect('/members/locker'));
}));

router.post('/images/:imageId/delete', writeLimiter, asyncRoute(async (req, res, next) => {
  const image = Tools.getImage(req.params.imageId);
  if (!image) return next();
  if (!canManage(req.user, image.owner_id)) {
    const err = new Error('That is not your photo to remove.');
    err.status = 403;
    return next(err);
  }
  Tools.deleteImage(image.id);
  await deleteImage(image.full_path, image.thumb_path);
  req.flash('success', 'Photo removed.');
  return req.session.save(() => res.redirect(`/members/locker/${image.tool_id}/edit`));
}));

/* -------------------------------------------------------- borrow requests */

router.post(
  '/:id/borrow',
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const tool = Tools.getTool(req.params.id);
    if (!tool) return next();

    if (Number(tool.owner_id) === Number(req.user.id)) {
      req.flash('error', 'That is your own tool.');
      return req.session.save(() => res.redirect(`/members/locker/${tool.id}`));
    }
    if (Tools.hasOpenRequest(tool.id, req.user.id)) {
      req.flash('error', 'You already have an open request for this tool.');
      return req.session.save(() => res.redirect(`/members/locker/${tool.id}`));
    }

    let data;
    try {
      data = validate(req.body, {
        message: f.string({ min: 10, max: 1500, label: 'Message' }),
        needed_from: f.datetime({ label: 'Needed from' }),
        needed_to: f.datetime({ label: 'Needed until' }),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        req.flash('error', Object.values(err.errors)[0]);
        return req.session.save(() => res.redirect(`/members/locker/${tool.id}`));
      }
      throw err;
    }

    const id = Tools.createBorrowRequest({
      toolId: tool.id,
      requesterId: req.user.id,
      message: stripHtml(data.message),
      neededFrom: data.needed_from,
      neededTo: data.needed_to,
    });

    // The owner's email address is never exposed to the requester -- the
    // notification goes out server-side, so the contact form cannot be used to
    // harvest member addresses.
    const owner = Users.findById(tool.owner_id);
    await sendMail({
      to: owner.email,
      ...borrowRequestEmail({
        ownerName: owner.first_name,
        requesterName: Users.displayName(req.user),
        toolName: tool.name,
        message: data.message,
        neededFrom: data.needed_from,
        neededTo: data.needed_to,
        link: absoluteUrl('/members/locker/requests'),
      }),
    });

    audit(req, 'locker.borrow.requested', { entity: 'borrow_request', entityId: id });
    req.flash('success', `Your request went to ${owner.first_name}. You will hear back by email.`);
    return req.session.save(() => res.redirect(`/members/locker/${tool.id}`));
  })
);

router.post(
  '/requests/:id/respond',
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const request = Tools.getBorrowRequest(req.params.id);
    if (!request) return next();
    if (!canManage(req.user, request.owner_id)) {
      const err = new Error('Only the tool owner can respond to that request.');
      err.status = 403;
      return next(err);
    }

    const status = ['approved', 'declined', 'returned'].includes(req.body.decision)
      ? req.body.decision
      : null;
    if (!status) {
      req.flash('error', 'Choose approve, decline or mark returned.');
      return req.session.save(() => res.redirect('/members/locker/requests'));
    }

    const reply = stripHtml(String(req.body.reply ?? '').slice(0, 1000));
    Tools.respondToRequest(request.id, { status, reply });

    // Keep the tool's availability in step with the loan.
    if (status === 'approved') Tools.setAvailability(request.tool_id, 'on-loan');
    if (status === 'returned') Tools.setAvailability(request.tool_id, 'available');

    await sendMail({
      to: request.req_email,
      ...borrowDecisionEmail({
        requesterName: request.req_first,
        toolName: request.tool_name,
        ownerName: Users.displayName(req.user),
        status,
        reply,
        link: absoluteUrl(`/members/locker/${request.tool_id}`),
      }),
    });

    audit(req, `locker.borrow.${status}`, { entity: 'borrow_request', entityId: request.id });
    req.flash('success', `Request ${status}.`);
    return req.session.save(() => res.redirect('/members/locker/requests'));
  })
);

router.post('/requests/:id/cancel', writeLimiter, (req, res, next) => {
  const request = Tools.getBorrowRequest(req.params.id);
  if (!request) return next();
  if (Number(request.requester_id) !== Number(req.user.id)) {
    const err = new Error('That is not your request to cancel.');
    err.status = 403;
    return next(err);
  }
  Tools.respondToRequest(request.id, { status: 'cancelled', reply: null });
  audit(req, 'locker.borrow.cancelled', { entity: 'borrow_request', entityId: request.id });
  req.flash('success', 'Request cancelled.');
  return req.session.save(() => res.redirect('/members/locker/requests'));
});

/* ------------------------------------------------------------------ utils */

/**
 * Runs each uploaded photo through the image pipeline and attaches it, while
 * respecting the per-tool image cap. Failures on one photo do not lose the
 * rest of the submission.
 */
async function storePhotos(toolId, files, body) {
  if (!files?.length) return;
  const alts = [].concat(body?.photo_alt ?? []);
  let slot = Tools.countImages(toolId);

  for (const [i, file] of files.entries()) {
    if (slot >= config.uploads.maxFilesPerTool) break;
    try {
      const img = await processImage(file.buffer, { folder: 'tools' });
      Tools.addImage(toolId, {
        fullPath: img.fullPath,
        thumbPath: img.thumbPath,
        alt: String(alts[i] ?? '').slice(0, 200) || null,
        width: img.width,
        height: img.height,
      });
      slot += 1;
    } catch (err) {
      console.warn(`[locker] skipped a photo for tool ${toolId}: ${err.message}`);
    }
  }
}

export default router;
