import express from 'express';
import * as Users from '../models/users.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { audit } from '../lib/audit.js';
import * as Notices from '../lib/notices.js';
import { whenOf, whereOf, rainDateText } from '../lib/event-format.js';
import { absoluteUrl } from '../middleware/base-path.js';

/**
 * Meeting notices: read, reword and (for the President, Vice President or Secretary) approve
 * the notice that goes to members before a meeting. Officers only; see lib/notices.js
 * for what happens to it and when.
 */
const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (Users.isBoard(req.user)) return next();
  const err = new Error('That area is for the chapter board.');
  err.status = 403;
  return next(err);
});

const schema = {
  subject: f.string({ min: 3, max: 140, label: 'Subject' }),
  speaker: f.optionalString({ max: 160, label: 'Speaker' }),
  agenda: f.optionalString({ max: 2000, label: 'Agenda' }),
  note: f.optionalString({ max: 2000, label: 'Message' }),
};

function show(req, res, notice, { errors = {}, form = null, status = 200 } = {}) {
  const when = notice.starts_at ? whenOf(notice) : null;
  return res.status(status).render('members/notice.njk', {
    title: notice.event_title ? `Notice: ${notice.event_title}` : 'Meeting notice',
    robots: 'noindex',
    notice,
    form: form ?? notice,
    errors,
    when,
    where: notice.starts_at ? whereOf(notice) : '',
    rainDate: rainDateText(notice),
    log: Notices.listLog(notice.id),
    statusLabels: Notices.STATUS_LABELS,
    audience: Users.mailRecipients('mail_meeting_notices').length,
    eventLink: notice.event_slug ? absoluteUrl(`/events/${notice.event_slug}`) : null,
    can: {
      edit: ['draft', 'approved'].includes(notice.status),
      approve: Users.canApproveNotice(req.user) && notice.status === 'draft',
      cancel: Users.canApproveNotice(req.user) && ['draft', 'approved'].includes(notice.status),
    },
  });
}
const back = (req, res, id, type, message) => {
  req.flash(type, message);
  return req.session.save(() => res.redirect(`/members/documents/notices/${id}`));
};

router.get('/:id', (req, res, next) => {
  const notice = Notices.getNotice(req.params.id);
  if (!notice) return next();
  return show(req, res, notice);
});

router.post('/:id', writeLimiter, (req, res, next) => {
  const notice = Notices.getNotice(req.params.id);
  if (!notice) return next();
  if (!Users.isBoard(req.user)) return next();
  let data;
  try {
    data = validate(req.body, schema);
  } catch (err) {
    if (err instanceof ValidationError) return show(req, res, notice, { errors: err.errors, form: req.body, status: 400 });
    throw err;
  }
  const result = Notices.edit(notice.id, data, req.user);
  if (!result.ok) return back(req, res, notice.id, 'error', result.reason);
  audit(req, 'notice.edited', { entity: 'notice', entityId: notice.id });
  return back(
    req,
    res,
    notice.id,
    'success',
    result.withdrew ? 'Saved. Because the wording changed, the approval was withdrawn: it needs approving again.' : 'Saved.'
  );
});

router.post('/:id/approve', writeLimiter, (req, res, next) => {
  const notice = Notices.getNotice(req.params.id);
  if (!notice) return next();
  if (!Users.canApproveNotice(req.user)) {
    const err = new Error('Only the President, Vice President or Secretary can approve a notice.');
    err.status = 403;
    return next(err);
  }
  const result = Notices.approve(notice.id, req.user);
  if (!result.ok) return back(req, res, notice.id, 'error', result.reason);
  audit(req, 'notice.approved', { entity: 'notice', entityId: notice.id });
  return back(req, res, notice.id, 'success', 'Approved. It will go to members at the scheduled time and be posted on the website.');
});

router.post('/:id/cancel', writeLimiter, (req, res, next) => {
  const notice = Notices.getNotice(req.params.id);
  if (!notice) return next();
  if (!Users.canApproveNotice(req.user)) {
    const err = new Error('Only the President, Vice President or Secretary can cancel a notice.');
    err.status = 403;
    return next(err);
  }
  if (!Notices.cancel(notice.id, req.user, 'Cancelled by hand.')) return back(req, res, notice.id, 'error', 'That notice can no longer be cancelled.');
  audit(req, 'notice.cancelled', { entity: 'notice', entityId: notice.id });
  return back(req, res, notice.id, 'success', 'Cancelled. Nothing will be sent for this meeting.');
});

router.post(
  '/:id/preview',
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const notice = Notices.getNotice(req.params.id);
    if (!notice || !notice.event_slug) return next();
    await Notices.sendPreview(notice, req.user);
    return back(req, res, notice.id, 'success', `A preview is on its way to ${req.user.email}.`);
  })
);

export default router;
