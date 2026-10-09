import express from 'express';
import multer from 'multer';
import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import * as Users from '../models/users.js';
import * as Posts from '../models/posts.js';
import * as Tools from '../models/tools.js';
import * as Events from '../models/events.js';
import { requireAuth } from '../middleware/auth.js';
import { writeLimiter, uploadLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { verifyMultipartCsrf } from '../lib/csrf.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { processImage, deleteImage } from '../lib/images.js';
import { listUserSessions } from '../lib/session-store.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

// Files are buffered in memory and re-encoded; nothing client-supplied ever
// reaches the filesystem.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 20 },
});

router.use(requireAuth);

/* -------------------------------------------------------------- dashboard */

router.get('/', (req, res) => {
  const inbox = Tools.requestsForOwner(req.user.id, { status: 'pending' });
  res.render('members/dashboard.njk', {
    title: 'Members Corner',
    robots: 'noindex',
    posts: Posts.listPosts({ viewer: req.user, limit: 4 }),
    myTools: Tools.listTools({ ownerId: req.user.id, limit: 6 }),
    inbox,
    myRequests: Tools.requestsByRequester(req.user.id).slice(0, 5),
    upcoming: Events.upcomingEvents({ limit: 3 }),
    stats: Tools.lockerStats(),
  });
});

/* ------------------------------------------------------------- directory */

router.get('/directory', (req, res) => {
  res.render('members/directory.njk', {
    title: 'Member directory',
    robots: 'noindex',
    members: Users.listMembers({ status: 'active' }),
  });
});

/* ---------------------------------------------------------------- account */

router.get('/account', (req, res) => {
  res.render('members/account.njk', {
    title: 'Your account',
    robots: 'noindex',
    form: req.user,
    errors: {},
    sessions: listUserSessions(req.user.id),
    currentSid: req.sessionID,
  });
});

router.post(
  '/account',
  writeLimiter,
  asyncRoute(async (req, res) => {
    let data;
    try {
      data = validate(req.body, {
        display_name: f.optionalString({ max: 80, label: 'Display name' }),
        phone: f.phone(),
        eaa_number: f.optionalString({ max: 20, label: 'EAA number' }),
        aircraft: f.optionalString({ max: 120, label: 'Aircraft' }),
        home_base: f.optionalString({ max: 80, label: 'Home base' }),
        bio: f.optionalString({ max: 1500, label: 'About you' }),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('members/account.njk', {
          title: 'Your account',
          robots: 'noindex',
          form: { ...req.user, ...req.body },
          errors: err.errors,
          sessions: listUserSessions(req.user.id),
          currentSid: req.sessionID,
        });
      }
      throw err;
    }

    Users.updateProfile(req.user.id, data);
    audit(req, 'member.profile.updated', { userId: req.user.id });
    req.flash('success', 'Profile saved.');
    return req.session.save(() => res.redirect('/members/account'));
  })
);

router.post(
  '/account/avatar',
  uploadLimiter,
  upload.single('avatar'),
  verifyMultipartCsrf,
  asyncRoute(async (req, res) => {
    if (!req.file) {
      req.flash('error', 'Choose an image first.');
      return req.session.save(() => res.redirect('/members/account'));
    }
    const processed = await processImage(req.file.buffer, { folder: 'avatars' });
    if (req.user.avatar_path) await deleteImage(req.user.avatar_path);
    Users.setAvatar(req.user.id, processed.thumbPath);
    audit(req, 'member.avatar.updated', { userId: req.user.id });
    req.flash('success', 'Photo updated.');
    return req.session.save(() => res.redirect('/members/account'));
  })
);

/**
 * A signed-in member changing their own password still goes through the reset
 * email. There is no form anywhere that accepts an old password and a new one,
 * which means a hijacked session alone cannot silently take over the account.
 */
router.post(
  '/account/password',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { sendMail, passwordResetEmail } = await import('../lib/mailer.js');
    const raw = Users.createPasswordResetToken(req.user.id);
    await sendMail({
      to: req.user.email,
      ...passwordResetEmail({
        name: req.user.first_name,
        link: absoluteUrl(`/reset/${raw}`),
        ttlMinutes: config.auth.resetTokenTtlMinutes,
      }),
    });
    audit(req, 'member.password.resetRequested', { userId: req.user.id });
    req.flash('success', 'Check your email for a link to set a new password.');
    return req.session.save(() => res.redirect('/members/account'));
  })
);

export default router;
