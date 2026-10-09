import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { normaliseRichField } from '../lib/richtext.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { all, get, run, nowIso } from '../db/index.js';
import * as Users from '../models/users.js';
import * as Events from '../models/events.js';
import * as Applications from '../models/applications.js';
import { requireAdmin, requireEditor } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { processImage, deleteImage } from '../lib/images.js';
import { destroyUserSessions } from '../lib/session-store.js';
import {
  sendMail,
  inviteEmail,
  applicationDeclinedEmail,
  recentOutbox,
  requeueMail,
  outboxHealth,
} from '../lib/mailer.js';
import { recentAudit } from '../lib/audit.js';
import { audit } from '../lib/audit.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 8, fields: 40 },
});

/* ============================ events (editors) ============================ */

router.get('/events', requireEditor, (req, res) => {
  res.render('admin/events.njk', {
    title: 'Manage events',
    robots: 'noindex',
    upcoming: Events.upcomingEvents({ limit: 50, includeDrafts: true }),
    past: Events.pastEvents({ limit: 50, includeDrafts: true }),
  });
});

const eventSchema = {
  title: f.string({ min: 4, max: 160, label: 'Title' }),
  summary: f.optionalString({ max: 400, label: 'Summary' }),
  body_md: f.optionalString({ max: 40000, label: 'Details' }),
  starts_at: f.datetime({ optional: false, label: 'Start' }),
  ends_at: f.datetime({ label: 'End' }),
  rain_date: f.datetime({ label: 'Rain date' }),
  all_day: f.bool(),
  location_name: f.optionalString({ max: 120, label: 'Location' }),
  address: f.optionalString({ max: 160, label: 'Address' }),
  city: f.optionalString({ max: 80, label: 'City' }),
  state: f.optionalString({ max: 2, label: 'State' }),
  zip: f.optionalString({ max: 10, label: 'ZIP' }),
  latitude: f.float({ min: -90, max: 90, label: 'Latitude' }),
  longitude: f.float({ min: -180, max: 180, label: 'Longitude' }),
  cost: f.optionalString({ max: 60, label: 'Cost' }),
  contact_name: f.optionalString({ max: 80, label: 'Contact name' }),
  contact_email: f.optionalString({ max: 254, label: 'Contact email' }),
  contact_phone: f.phone(),
  external_url: f.url({ label: 'External link' }),
  poster_alt: f.optionalString({ max: 200, label: 'Poster description' }),
  kind: f.enum(['chapter', 'fly-in', 'young-eagles', 'workshop', 'meeting', 'social'], {
    label: 'Type',
    fallback: 'chapter',
  }),
  status: f.enum(['draft', 'published', 'cancelled'], { label: 'Status', fallback: 'published' }),
  recap_md: f.optionalString({ max: 40000, label: 'Recap' }),
  attendance: f.int({ min: 0, max: 100000, optional: true, label: 'Attendance' }),
};

router.get('/events/new', requireEditor, (req, res) => {
  res.render('admin/event-edit.njk', {
    title: 'New event',
    robots: 'noindex',
    event: {
      status: 'published',
      kind: 'fly-in',
      location_name: `${config.site.airport.name} (${config.site.airport.ident})`,
      address: config.site.airport.street,
      city: config.site.airport.city,
      state: config.site.airport.state,
      zip: config.site.airport.zip,
      latitude: config.site.airport.latitude,
      longitude: config.site.airport.longitude,
      photos: [],
    },
    errors: {},
    isNew: true,
  });
});

router.get('/events/:id/edit', requireEditor, (req, res, next) => {
  const event = Events.getEventById(req.params.id);
  if (!event) return next();
  event.photos = Events.getEventBySlug(event.slug, { viewer: req.user })?.photos ?? [];
  res.render('admin/event-edit.njk', {
    title: `Edit: ${event.title}`,
    robots: 'noindex',
    event,
    errors: {},
    isNew: false,
  });
});

async function saveEventHandler(req, res, next) {
  const id = req.params.id ? Number(req.params.id) : null;
  const existing = id ? Events.getEventById(id) : null;
  if (id && !existing) return next();

  let data;
  try {
    // Two rich fields on this form; normalise each before validating.
    const body = normaliseRichField(normaliseRichField(req.body, 'body_md'), 'recap_md');
    data = validate(body, eventSchema);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).render('admin/event-edit.njk', {
        title: id ? 'Edit event' : 'New event',
        robots: 'noindex',
        event: { ...(existing ?? {}), ...req.body, photos: existing?.photos ?? [] },
        errors: err.errors,
        isNew: !id,
      });
    }
    throw err;
  }

  const fields = {
    title: data.title,
    summary: data.summary,
    bodyMd: data.body_md,
    startsAt: data.starts_at,
    endsAt: data.ends_at,
    allDay: data.all_day,
    rainDate: data.rain_date,
    locationName: data.location_name,
    address: data.address,
    city: data.city,
    state: data.state,
    zip: data.zip,
    latitude: data.latitude,
    longitude: data.longitude,
    cost: data.cost,
    contactName: data.contact_name,
    contactEmail: data.contact_email,
    contactPhone: data.contact_phone,
    externalUrl: data.external_url,
    posterAlt: data.poster_alt,
    kind: data.kind,
    status: data.status,
    recapMd: data.recap_md,
    attendance: data.attendance,
  };

  const poster = req.files?.find((file) => file.fieldname === 'poster');
  if (poster) {
    const img = await processImage(poster.buffer, { folder: 'events' });
    fields.posterPath = img.fullPath;
    if (existing?.poster_path) await deleteImage(existing.poster_path);
  }

  const eventId = Events.saveEvent(fields, id);

  for (const file of req.files?.filter((file) => file.fieldname === 'photos') ?? []) {
    try {
      const img = await processImage(file.buffer, { folder: 'events' });
      Events.addPhoto(eventId, { fullPath: img.fullPath, thumbPath: img.thumbPath });
    } catch (err) {
      console.warn(`[events] skipped a photo: ${err.message}`);
    }
  }

  audit(req, id ? 'event.updated' : 'event.created', {
    entity: 'event',
    entityId: eventId,
    detail: data.title,
  });
  req.flash('success', 'Event saved.');
  return req.session.save(() => res.redirect('/members/admin/events'));
}

router.post(
  '/events/new',
  requireEditor,
  writeLimiter,
  uploadLimiter,
  upload.any(),
  verifyMultipartCsrf,
  asyncRoute(saveEventHandler)
);
router.post(
  '/events/:id/edit',
  requireEditor,
  writeLimiter,
  uploadLimiter,
  upload.any(),
  verifyMultipartCsrf,
  asyncRoute(saveEventHandler)
);

router.post('/events/:id/delete', requireEditor, writeLimiter, asyncRoute(async (req, res, next) => {
  const event = Events.getEventById(req.params.id);
  if (!event) return next();
  const photos = Events.deleteEvent(event.id);
  await deleteImage(
    event.poster_path,
    ...photos.flatMap((p) => [p.full_path, p.thumb_path])
  );
  audit(req, 'event.deleted', { entity: 'event', entityId: event.id, detail: event.title });
  req.flash('success', 'Event deleted.');
  return req.session.save(() => res.redirect('/members/admin/events'));
}));

router.post('/events/photos/:photoId/delete', requireEditor, writeLimiter, asyncRoute(async (req, res, next) => {
  const photo = Events.getPhoto(req.params.photoId);
  if (!photo) return next();
  Events.deletePhoto(photo.id);
  await deleteImage(photo.full_path, photo.thumb_path);
  req.flash('success', 'Photo removed.');
  return req.session.save(() => res.redirect(`/members/admin/events/${photo.event_id}/edit`));
}));

/* ============================= people (admin) ============================ */

router.get('/members', requireAdmin, (req, res) => {
  res.render('admin/members.njk', {
    title: 'Manage members',
    robots: 'noindex',
    members: Users.listMembers({}),
    invites: Users.pendingInvites(),
    errors: {},
    form: {},
  });
});

router.post(
  '/members/invite',
  requireAdmin,
  writeLimiter,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(req.body, {
        email: f.email(),
        first_name: f.string({ min: 1, max: 60, label: 'First name' }),
        last_name: f.string({ min: 1, max: 60, label: 'Last name' }),
        role: f.enum(['member', 'editor', 'admin'], { label: 'Role', fallback: 'member' }),
        note: f.optionalString({ max: 200, label: 'Note' }),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('admin/members.njk', {
          title: 'Manage members',
          robots: 'noindex',
          members: Users.listMembers({}),
          invites: Users.pendingInvites(),
          errors: err.errors,
          form: req.body,
        });
      }
      throw err;
    }

    let user = Users.findByEmail(data.email);
    if (!user) {
      user = Users.createUser({
        email: data.email,
        firstName: data.first_name,
        lastName: data.last_name,
        role: data.role,
        status: 'pending',
      });
    }

    // The invite carries a reset token, so the admin never picks a password
    // for anyone -- there is no moment where a plaintext password exists on
    // the server or in an admin's hands.
    const raw = Users.createInvite({
      email: data.email,
      role: data.role,
      invitedBy: req.user.id,
      note: data.note,
    });

    await sendMail({
      to: data.email,
      ...inviteEmail({
        name: data.first_name,
        link: absoluteUrl(`/invite/${raw}`),
        invitedBy: Users.displayName(req.user),
        ttlDays: config.auth.inviteTtlDays,
      }),
    });

    audit(req, 'admin.invite.sent', { entity: 'user', entityId: user.id, detail: data.email });
    req.flash('success', `Invitation sent to ${data.email}.`);
    return req.session.save(() => res.redirect('/members/admin/members'));
  })
);

router.post('/members/:id/role', requireAdmin, writeLimiter, (req, res, next) => {
  const target = Users.findById(req.params.id);
  if (!target) return next();
  const role = ['member', 'editor', 'admin'].includes(req.body.role) ? req.body.role : null;
  if (!role) return next();

  // Guard against locking the chapter out of its own admin area.
  if (target.role === 'admin' && role !== 'admin' && Users.countAdmins() <= 1) {
    req.flash('error', 'That is the last administrator. Promote someone else first.');
    return req.session.save(() => res.redirect('/members/admin/members'));
  }

  Users.setRole(target.id, role);
  audit(req, 'admin.role.changed', { entity: 'user', entityId: target.id, detail: role });
  req.flash('success', `${Users.displayName(target)} is now ${role}.`);
  return req.session.save(() => res.redirect('/members/admin/members'));
});

router.post('/members/:id/status', requireAdmin, writeLimiter, (req, res, next) => {
  const target = Users.findById(req.params.id);
  if (!target) return next();
  const status = ['active', 'suspended', 'pending'].includes(req.body.status)
    ? req.body.status
    : null;
  if (!status) return next();

  if (Number(target.id) === Number(req.user.id) && status !== 'active') {
    req.flash('error', 'You cannot suspend your own account.');
    return req.session.save(() => res.redirect('/members/admin/members'));
  }

  Users.setStatus(target.id, status);
  // Suspension must take effect immediately, not at session expiry.
  if (status !== 'active') destroyUserSessions(target.id);
  audit(req, 'admin.status.changed', { entity: 'user', entityId: target.id, detail: status });
  req.flash('success', `${Users.displayName(target)} is now ${status}.`);
  return req.session.save(() => res.redirect('/members/admin/members'));
});

const memberDetailsSchema = {
  first_name: f.string({ min: 1, max: 60, label: 'First name' }),
  last_name: f.string({ min: 1, max: 60, label: 'Last name' }),
  email: f.email(),
  phone: f.phone(),
  eaa_number: f.optionalString({ max: 20, label: 'EAA number' }),
};

function renderMemberEdit(res, target, { errors = {}, form = null, status = 200 } = {}) {
  return res.status(status).render('admin/member-edit.njk', {
    title: `Edit ${Users.displayName(target)}`,
    robots: 'noindex',
    member: target,
    form: form || target,
    errors,
    footprint: Users.memberFootprint(target.id),
  });
}

router.get('/members/:id/edit', requireAdmin, (req, res, next) => {
  const target = Users.findById(req.params.id);
  if (!target) return next();
  return renderMemberEdit(res, target);
});

router.post('/members/:id/edit', requireAdmin, writeLimiter, (req, res, next) => {
  const target = Users.findById(req.params.id);
  if (!target) return next();

  let data;
  try {
    data = validate(req.body, memberDetailsSchema);
  } catch (err) {
    if (err instanceof ValidationError) return renderMemberEdit(res, target, { errors: err.errors, form: req.body, status: 400 });
    throw err;
  }

  const clash = Users.findByEmail(data.email);
  if (clash && Number(clash.id) !== Number(target.id)) {
    return renderMemberEdit(res, target, {
      errors: { email: `${Users.displayName(clash)} already uses that address.` },
      form: req.body,
      status: 400,
    });
  }

  const { emailChanged, before } = Users.adminUpdateDetails(target.id, {
    firstName: data.first_name,
    lastName: data.last_name,
    email: data.email,
    phone: data.phone,
    eaaNumber: data.eaa_number,
  });
  audit(req, 'admin.member.updated', {
    entity: 'user',
    entityId: target.id,
    detail: emailChanged ? `email ${before.email} -> ${data.email}` : 'details',
  });

  const name = `${data.first_name} ${data.last_name}`;
  if (emailChanged && !target.password_set_at) {
    req.flash(
      'success',
      `Saved. ${name}'s email is now ${data.email}. Any link already sent to the old address no longer ` +
        'works; use Re-invite to send a fresh one.'
    );
  } else if (emailChanged) {
    req.flash('success', `Saved. ${name} now signs in with ${data.email}; their password is unchanged.`);
  } else {
    req.flash('success', `Saved ${name}.`);
  }
  return req.session.save(() => res.redirect('/members/admin/members'));
});

router.post(
  '/members/:id/delete',
  requireAdmin,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const target = Users.findById(req.params.id);
    if (!target) return next();

    if (Number(target.id) === Number(req.user.id)) {
      req.flash('error', 'You cannot remove your own account. Ask another administrator.');
      return req.session.save(() => res.redirect(`/members/admin/members/${target.id}/edit`));
    }
    if (target.role === 'admin' && target.status === 'active' && Users.countAdmins() <= 1) {
      req.flash('error', 'That is the last administrator. Promote someone else first.');
      return req.session.save(() => res.redirect(`/members/admin/members/${target.id}/edit`));
    }
    // A deliberate second step, checked here rather than trusted to a
    // browser dialog that a script or a stray double-click can skip.
    if (req.body.confirm !== 'remove') {
      req.flash('error', 'Tick the box to confirm, then press Remove.');
      return req.session.save(() => res.redirect(`/members/admin/members/${target.id}/edit`));
    }

    const footprint = Users.memberFootprint(target.id);
    const { user, files } = Users.deleteMember(target.id);
    // Files go only after the database change has committed: a failure here
    // leaves an unused file behind, never a record pointing at nothing.
    await deleteImage(...files);
    audit(req, 'admin.member.deleted', {
      entity: 'user',
      entityId: user.id,
      detail: `${user.email} (${footprint.tools} tools, ${footprint.builds} builds)`,
    });
    req.flash('success', `${Users.displayName(user)} has been removed.`);
    return req.session.save(() => res.redirect('/members/admin/members'));
  })
);

router.post(
  '/members/:id/resend',
  requireAdmin,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const target = Users.findById(req.params.id);
    if (!target) return next();
    const raw = Users.createInvite({
      email: target.email,
      role: target.role,
      invitedBy: req.user.id,
    });
    await sendMail({
      to: target.email,
      ...inviteEmail({
        name: target.first_name,
        link: absoluteUrl(`/invite/${raw}`),
        invitedBy: Users.displayName(req.user),
        ttlDays: config.auth.inviteTtlDays,
      }),
    });
    audit(req, 'admin.invite.resent', { entity: 'user', entityId: target.id });
    req.flash('success', `New invitation sent to ${target.email}.`);
    return req.session.save(() => res.redirect('/members/admin/members'));
  })
);

/* ====================== membership applications (admin) ================= */

router.get('/applications', requireAdmin, (req, res) => {
  res.render('admin/applications.njk', {
    title: 'Membership requests',
    robots: 'noindex',
    applications: Applications.listApplications(),
    pending: Applications.pendingCount(),
  });
});

/**
 * Approving creates the account and sends an invitation. Note what it does
 * *not* do: it never sets a password. The applicant follows the same one-time
 * link every other member does, so an administrator never handles a
 * credential.
 */
router.post(
  '/applications/:id/approve',
  requireAdmin,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const application = Applications.getApplication(req.params.id);
    if (!application) return next();
    if (application.status !== 'pending') {
      req.flash('error', 'That request has already been dealt with.');
      return req.session.save(() => res.redirect('/members/admin/applications'));
    }

    const role = ['member', 'editor'].includes(req.body.role) ? req.body.role : 'member';
    const note = String(req.body.note ?? '').slice(0, 500) || null;

    let user = Users.findByEmail(application.email);
    if (!user) {
      user = Users.createUser({
        email: application.email,
        firstName: application.first_name,
        lastName: application.last_name,
        role,
        status: 'pending',
        phone: application.phone,
        eaaNumber: application.eaa_number,
        aircraft: application.aircraft,
        homeBase: application.home_base,
      });
    }

    const raw = Users.createInvite({
      email: application.email,
      role,
      invitedBy: req.user.id,
      note: 'Approved membership request',
    });

    await sendMail({
      to: application.email,
      ...inviteEmail({
        name: application.first_name,
        link: absoluteUrl(`/invite/${raw}`),
        invitedBy: Users.displayName(req.user),
        ttlDays: config.auth.inviteTtlDays,
      }),
    });

    Applications.markReviewed(application.id, {
      status: 'approved',
      reviewerId: req.user.id,
      note,
      userId: user.id,
    });

    audit(req, 'application.approved', {
      entity: 'membership_application',
      entityId: application.id,
      detail: application.email,
    });
    req.flash('success', `Approved. ${application.first_name} has an invitation to set a password.`);
    return req.session.save(() => res.redirect('/members/admin/applications'));
  })
);

router.post(
  '/applications/:id/decline',
  requireAdmin,
  writeLimiter,
  asyncRoute(async (req, res, next) => {
    const application = Applications.getApplication(req.params.id);
    if (!application) return next();
    if (application.status !== 'pending') {
      req.flash('error', 'That request has already been dealt with.');
      return req.session.save(() => res.redirect('/members/admin/applications'));
    }

    const note = String(req.body.note ?? '').slice(0, 500) || null;
    const notify = req.body.notify === '1';

    if (notify) {
      await sendMail({
        to: application.email,
        ...applicationDeclinedEmail({ name: application.first_name, note }),
      });
    }

    Applications.markReviewed(application.id, {
      status: 'declined',
      reviewerId: req.user.id,
      note,
    });

    audit(req, 'application.declined', {
      entity: 'membership_application',
      entityId: application.id,
    });
    req.flash('success', notify ? 'Declined, and they have been told.' : 'Declined quietly.');
    return req.session.save(() => res.redirect('/members/admin/applications'));
  })
);

/* ============================ inbox & logging =========================== */

router.get('/messages', requireEditor, (req, res) => {
  res.render('admin/messages.njk', {
    title: 'Contact messages',
    robots: 'noindex',
    messages: all('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 200'),
  });
});

router.post('/messages/:id/handled', requireEditor, writeLimiter, (req, res) => {
  run('UPDATE contact_messages SET handled_at = ? WHERE id = ?', [nowIso(), Number(req.params.id)]);
  req.flash('success', 'Marked as handled.');
  return req.session.save(() => res.redirect('/members/admin/messages'));
});

router.get('/log', requireAdmin, (req, res) => {
  res.render('admin/log.njk', {
    title: 'Activity log',
    robots: 'noindex',
    entries: recentAudit(200),
    outbox: recentOutbox(50),
    mailHealth: outboxHealth(),
    mailLive: config.mail.transport === 'smtp',
  });
});

/**
 * During setup (before SMTP exists) an admin needs to read the invite and
 * reset links the site generated. Admin-only, and never shown in production
 * unless explicitly enabled, because these bodies contain live tokens.
 */
router.get('/log/mail/:id', requireAdmin, (req, res, next) => {
  if (config.isProd && process.env.ALLOW_OUTBOX_VIEW !== '1') {
    const err = new Error('Reading queued mail is disabled in production.');
    err.status = 403;
    return next(err);
  }
  const mail = get('SELECT * FROM email_outbox WHERE id = ?', [Number(req.params.id)]);
  if (!mail) return next();
  audit(req, 'admin.outbox.viewed', { entity: 'email', entityId: mail.id });
  res.render('admin/mail.njk', { title: 'Queued message', robots: 'noindex', mail });
});

/**
 * Try a failed message again.
 *
 * Separate from the view route above, and not gated on ALLOW_OUTBOX_VIEW,
 * because retrying reveals nothing: it needs the id and shows no body. Which
 * matters, since the common case is fixing an SMTP setting in production and
 * wanting the invitation that bounced off it to go out now.
 */
router.post('/log/mail/:id/retry', requireAdmin, writeLimiter, (req, res) => {
  const ok = requeueMail(req.params.id);
  if (ok) {
    audit(req, 'admin.outbox.requeued', { entity: 'email', entityId: Number(req.params.id) });
    req.flash(
      'success',
      config.mail.transport === 'smtp'
        ? 'Back in the queue — it will go out within the minute.'
        : 'Queued, but MAIL_TRANSPORT is still "outbox", so nothing will be delivered.'
    );
  } else {
    req.flash('error', 'That message was already sent, or no longer exists.');
  }
  return req.session.save(() => res.redirect('/members/admin/log'));
});

export default router;
