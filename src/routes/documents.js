import fs from 'node:fs';
import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import * as Users from '../models/users.js';
import * as Docs from '../models/documents.js';
import * as Notices from '../lib/notices.js';
import { whenOf } from '../lib/event-format.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { storeDocument, deleteDocumentFile, documentPath, DocumentError, ALLOWED_LABEL } from '../lib/document-files.js';
import { audit } from '../lib/audit.js';
import { sendMail, documentSubmittedEmail, documentReviewedEmail } from '../lib/mailer.js';

/**
 * Chapter documents.
 *
 *   /members/documents            the archive every member can read
 *   /members/documents/board      the board's workspace (officers only)
 *
 * Officers add and submit documents; the President or Vice President approves;
 * the President, Vice President or Secretary publishes. Everyone else, administrators
 * included, sees only what has been published. (An administrator can still name
 * themselves to an office, and that is recorded in the audit log.)
 */

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.documents.maxBytes, files: 1, fields: 10 },
});

/** Runs multer, turning its own errors (too big, too many) into a message the form can show. */
function receiveFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) req.uploadProblem = err.code === 'LIMIT_FILE_SIZE'
      ? `Files must be under ${Math.round(config.documents.maxBytes / 1024 / 1024)} MB.`
      : 'That upload could not be read.';
    next();
  });
}

const isOfficer = (user) => Users.isBoard(user);
// Officers only. Being an administrator (the site's technical role) does not open the board's papers.
const canReadBoard = (user) => Users.isBoard(user);
const canPublish = Users.canPublish;

function deny(next, message = 'That area is for the chapter board.') {
  const err = new Error(message);
  err.status = 403;
  return next(err);
}

const requireOfficer = (req, res, next) => (isOfficer(req.user) ? next() : deny(next, 'Only a chapter officer can do that.'));
const requireBoardReader = (req, res, next) => (canReadBoard(req.user) ? next() : deny(next));

function back(req, res, id, type, message) {
  req.flash(type, message);
  return req.session.save(() => res.redirect(`/members/documents/${id}`));
}

const newSchema = {
  kind: f.enum(Object.keys(Docs.KINDS), { label: 'Type' }),
  title: f.string({ min: 2, max: 140, label: 'Title' }),
  meeting_date: (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T12:00:00Z`))) throw 'Meeting date must be a valid date.';
    return raw;
  },
  note: f.optionalString({ max: 500, label: 'Note' }),
};

/* ------------------------------------------------------------- archive */

router.get('/', (req, res) => {
  const docs = Docs.listPublished();
  const years = [];
  for (const d of docs) {
    const year = (d.meeting_date || d.created_at).slice(0, 4);
    let group = years.find((y) => y.year === year);
    if (!group) years.push((group = { year, docs: [] }));
    group.docs.push(d);
  }
  res.render('members/documents.njk', {
    title: 'Chapter documents',
    robots: 'noindex',
    years,
    kinds: Docs.KINDS,
    canReadBoard: canReadBoard(req.user),
  });
});

/* ----------------------------------------------------------- workspace */

router.get('/board', requireBoardReader, (req, res) => {
  res.render('members/documents-board.njk', {
    title: 'Board documents',
    robots: 'noindex',
    docs: Docs.listAll(),
    notices: Notices.listRecent().map((n) => ({ ...n, when: n.starts_at ? whenOf(n) : null })),
    noticeLabels: Notices.STATUS_LABELS,
    kinds: Docs.KINDS,
    statusLabels: Docs.STATUS_LABELS,
    isOfficer: isOfficer(req.user),
    canApprove: Users.canApprove(req.user),
    canApproveNotice: Users.canApproveNotice(req.user),
  });
});

function renderNew(res, { errors = {}, form = {}, status = 200 } = {}) {
  return res.status(status).render('members/document-new.njk', {
    title: 'Add a document',
    robots: 'noindex',
    errors,
    form,
    kinds: Docs.KINDS,
    maxMb: Math.round(config.documents.maxBytes / 1024 / 1024),
    allowed: ALLOWED_LABEL,
  });
}

router.get('/board/new', requireOfficer, (req, res) => renderNew(res, { form: { kind: 'minutes' } }));

router.post(
  '/board',
  requireOfficer,
  writeLimiter,
  uploadLimiter,
  receiveFile,
  verifyMultipartCsrf,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(req.body, newSchema);
    } catch (err) {
      if (err instanceof ValidationError) return renderNew(res, { errors: err.errors, form: req.body, status: 400 });
      throw err;
    }
    let stored;
    try {
      if (req.uploadProblem) throw new DocumentError(req.uploadProblem);
      if (!req.file) throw new DocumentError('Choose a file to upload.');
      stored = await storeDocument(req.file.buffer, req.file.originalname);
    } catch (err) {
      if (err instanceof DocumentError) return renderNew(res, { errors: { file: err.message }, form: req.body, status: 400 });
      throw err;
    }
    const id = Docs.createDocument({
      kind: data.kind,
      title: data.title,
      meetingDate: data.meeting_date,
      note: data.note,
      file: stored,
      user: req.user,
    });
    audit(req, 'document.created', { entity: 'document', entityId: id, detail: `${data.kind}: ${data.title} (${stored.sha256.slice(0, 12)})` });
    return back(req, res, id, 'success', 'Saved as a draft. Send it for review when it is ready.');
  })
);

/* ------------------------------------------------------------- one document */

router.get('/:id', (req, res, next) => {
  const doc = Docs.getDocument(req.params.id);
  if (!doc) return next();

  if (!canReadBoard(req.user)) {
    // Members see a document only once it has been published.
    const version = Docs.getPublishedVersion(doc.id);
    if (!version) return next();
    return res.render('members/document.njk', {
      title: doc.title,
      robots: 'noindex',
      doc,
      kinds: Docs.KINDS,
      statusLabels: Docs.STATUS_LABELS,
      memberView: true,
      published: version,
      versions: [],
      can: {},
    });
  }

  const versions = Docs.listVersions(doc.id).map((v, _i, all) => ({
    ...v,
    deleteBlocker: Docs.deletionBlocker(doc, all, v, req.user),
  }));
  const published = doc.published_version_id ? versions.find((v) => v.id === doc.published_version_id) : null;
  res.render('members/document.njk', {
    title: doc.title,
    robots: 'noindex',
    doc,
    kinds: Docs.KINDS,
    statusLabels: Docs.STATUS_LABELS,
    memberView: false,
    published,
    versions,
    events: Docs.listEvents(doc.id),
    maxMb: Math.round(config.documents.maxBytes / 1024 / 1024),
    allowed: ALLOWED_LABEL,
    can: {
      edit: isOfficer(req.user) && doc.status !== 'in_review',
      submit: isOfficer(req.user) && ['draft', 'changes_requested'].includes(doc.status),
      review: Users.canApprove(req.user) && doc.status === 'in_review',
      // Not offered when the approved version is the one already published.
      publish: canPublish(req.user) && doc.status === 'approved' && doc.published_version_id !== versions[0].id,
      unpublish: canPublish(req.user) && Boolean(doc.published_version_id),
    },
  });
});

/** Streams a stored file as a download, never inline, whatever it is. */
function sendFile(res, next, version) {
  const abs = documentPath(version.stored_name);
  if (!abs) return next();
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return next();
    res.setHeader('Content-Type', version.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${version.original_name.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(abs).on('error', next).pipe(res);
  });
}

/** The version members may read: the published one. */
router.get('/:id/download', (req, res, next) => {
  const version = Docs.getPublishedVersion(req.params.id);
  if (!version) return next();
  audit(req, 'document.downloaded', { entity: 'document', entityId: version.document_id, detail: `published v${version.number}` });
  return sendFile(res, next, version);
});

/** Any version, for the board. */
router.get('/:id/versions/:number/download', requireBoardReader, (req, res, next) => {
  const version = Docs.getVersion(req.params.id, req.params.number);
  if (!version) return next();
  audit(req, 'document.downloaded', { entity: 'document', entityId: version.document_id, detail: `v${version.number}` });
  return sendFile(res, next, version);
});

router.post(
  '/:id/versions',
  requireOfficer,
  writeLimiter,
  uploadLimiter,
  receiveFile,
  verifyMultipartCsrf,
  asyncRoute(async (req, res, next) => {
    const doc = Docs.getDocument(req.params.id);
    if (!doc) return next();
    let stored;
    try {
      if (req.uploadProblem) throw new DocumentError(req.uploadProblem);
      if (!req.file) throw new DocumentError('Choose a file to upload.');
      stored = await storeDocument(req.file.buffer, req.file.originalname);
    } catch (err) {
      if (err instanceof DocumentError) return back(req, res, doc.id, 'error', err.message);
      throw err;
    }
    const note = f.optionalString({ max: 500 })(req.body.note, 'note');
    try {
      const number = Docs.addVersion(doc.id, { note, file: stored, user: req.user });
      audit(req, 'document.version.added', { entity: 'document', entityId: doc.id, detail: `v${number} (${stored.sha256.slice(0, 12)})` });
      return back(req, res, doc.id, 'success', `Version ${number} saved as a draft.`);
    } catch (err) {
      await deleteDocumentFile(stored.storedName);
      if (err instanceof Docs.DocumentStateError) return back(req, res, doc.id, 'error', err.message);
      throw err;
    }
  })
);

router.post(
  '/:id/submit',
  requireOfficer,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    let doc;
    try {
      doc = Docs.submitForReview(req.params.id, req.user);
    } catch (err) {
      if (err instanceof Docs.DocumentStateError) return back(req, res, req.params.id, 'error', err.message);
      throw err;
    }
    audit(req, 'document.submitted', { entity: 'document', entityId: doc.id, detail: `v${doc.latest_number}` });
    // Tell the other approver(s). Someone who submits their own document does not need telling.
    const reviewers = Users.listBoard().filter((u) => Users.canApprove(u) && u.id !== req.user.id);
    for (const r of reviewers) {
      await sendMail({
        to: r.email,
        ...documentSubmittedEmail({
          reviewerName: r.first_name,
          submitterName: Users.displayName(req.user),
          title: doc.title,
          kind: Docs.KINDS[doc.kind],
          version: doc.latest_number,
          link: absoluteUrl(`/members/documents/${doc.id}`),
        }),
      });
    }
    return back(req, res, doc.id, 'success', reviewers.length ? 'Sent for review. The President and Vice President have been emailed.' : 'Sent for review.');
  })
);

router.post(
  '/:id/review',
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    if (!Users.canApprove(req.user)) return deny(next, 'Only the President or Vice President can approve a document.');
    const decision = ['approved', 'changes_requested'].includes(req.body.decision) ? req.body.decision : null;
    if (!decision) return back(req, res, req.params.id, 'error', 'Choose approve or request changes.');
    const comment = f.optionalString({ max: 1000 })(req.body.comment, 'comment');
    if (decision === 'changes_requested' && !comment) {
      return back(req, res, req.params.id, 'error', 'Say what needs to change.');
    }
    let result;
    try {
      result = Docs.recordReview(req.params.id, { versionNumber: req.body.version, decision, comment, reviewer: req.user });
    } catch (err) {
      if (err instanceof Docs.DocumentStateError) return back(req, res, req.params.id, 'error', err.message);
      throw err;
    }
    const { doc, version } = result;
    audit(req, 'document.reviewed', {
      entity: 'document',
      entityId: doc.id,
      detail: `v${version.number} ${decision} (${version.sha256.slice(0, 12)})`,
    });
    const submitter = version.submitted_by && version.submitted_by !== req.user.id ? Users.findById(version.submitted_by) : null;
    if (submitter && submitter.status === 'active') {
      await sendMail({
        to: submitter.email,
        ...documentReviewedEmail({
          name: submitter.first_name,
          reviewerName: Users.displayName(req.user),
          reviewerOffice: Users.BOARD_ROLES[req.user.board_role],
          title: doc.title,
          decision,
          comment,
          link: absoluteUrl(`/members/documents/${doc.id}`),
        }),
      });
    }
    return back(req, res, doc.id, 'success', decision === 'approved' ? 'Approved.' : 'Changes requested.');
  })
);

router.post(
  '/:id/versions/:number/delete',
  requireOfficer,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const doc = Docs.getDocument(req.params.id);
    if (!doc) return next();
    let storedName;
    try {
      storedName = Docs.deleteVersion(doc.id, req.params.number, req.user);
    } catch (err) {
      if (err instanceof Docs.DocumentStateError) return back(req, res, doc.id, 'error', err.message);
      throw err;
    }
    // Only after the database change has committed, so a failure here can at worst leave an orphan file.
    await deleteDocumentFile(storedName);
    audit(req, 'document.version.deleted', { entity: 'document', entityId: doc.id, detail: `v${req.params.number}` });
    return back(req, res, doc.id, 'success', `Version ${req.params.number} deleted. The history keeps a note of it.`);
  })
);

router.post('/:id/publish', writeLimiter, (req, res, next) => {
  if (!canPublish(req.user)) return deny(next, 'Only the President, Vice President or Secretary can publish a document.');
  try {
    const version = Docs.publish(req.params.id, req.user);
    audit(req, 'document.published', { entity: 'document', entityId: version.document_id, detail: `v${version.number} (${version.sha256.slice(0, 12)})` });
    return back(req, res, version.document_id, 'success', 'Published. Every member can now read it in the chapter documents.');
  } catch (err) {
    if (err instanceof Docs.DocumentStateError) return back(req, res, req.params.id, 'error', err.message);
    throw err;
  }
});

router.post('/:id/unpublish', writeLimiter, (req, res, next) => {
  if (!canPublish(req.user)) return deny(next, 'Only the President, Vice President or Secretary can do that.');
  const doc = Docs.getDocument(req.params.id);
  if (!doc) return next();
  Docs.unpublish(doc.id, req.user);
  audit(req, 'document.unpublished', { entity: 'document', entityId: doc.id });
  return back(req, res, doc.id, 'success', 'Taken down. Members can no longer see it.');
});

export default router;
