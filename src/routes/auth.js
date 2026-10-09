import express from 'express';
import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import * as Users from '../models/users.js';
import { verifyPassword, fakeVerify, checkPasswordStrength, isBreachedPassword } from '../lib/passwords.js';
import { rotateCsrf } from '../lib/csrf.js';
import { destroyUserSessions } from '../lib/session-store.js';
import { loginLimiter, passwordResetLimiter } from '../middleware/rate-limit.js';
import { redirectIfAuthed, requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/errors.js';
import { sendMail, passwordResetEmail } from '../lib/mailer.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

/**
 * Deliberately identical for every failure mode -- wrong password, unknown
 * address, unverified account. Anything more specific hands an attacker a
 * free account-enumeration oracle.
 */
const GENERIC_LOGIN_ERROR = 'That email and password combination did not work.';

/* ------------------------------------------------------------------ login */

router.get('/login', redirectIfAuthed, (req, res) => {
  res.render('pages/login.njk', {
    title: 'Members sign in',
    metaDescription: 'Sign in to the EAA Chapter 1699 Members Corner.',
    form: {},
    error: null,
    robots: 'noindex',
  });
});

router.post(
  '/login',
  redirectIfAuthed,
  loginLimiter,
  asyncRoute(async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const password = String(req.body.password ?? '');

    const fail = (reason) => {
      audit(req, 'auth.login.failed', { detail: reason });
      return res.status(401).render('pages/login.njk', {
        title: 'Members sign in',
        form: { email },
        error: GENERIC_LOGIN_ERROR,
        robots: 'noindex',
      });
    };

    const user = Users.findForAuth(email);

    // No account, or an account that has never set a password: still burn the
    // same CPU so the response time does not reveal which case we are in.
    if (!user || !user.password_hash) {
      await fakeVerify(password);
      return fail(user ? 'no-password-set' : 'unknown-email');
    }

    if (Users.isLockedOut(user)) {
      await fakeVerify(password);
      audit(req, 'auth.login.locked', { userId: user.id });
      return res.status(429).render('pages/login.njk', {
        title: 'Members sign in',
        form: { email },
        error: `Too many failed attempts. This account is locked for ${config.auth.lockoutMinutes} minutes. You can reset your password to unlock it sooner.`,
        robots: 'noindex',
      });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      Users.recordFailedLogin(user.id);
      return fail('bad-password');
    }

    if (user.status !== 'active') {
      audit(req, 'auth.login.inactive', { userId: user.id });
      return fail('inactive-account');
    }

    Users.recordSuccessfulLogin(user.id);

    // Regenerating the session issues a brand-new id at the moment privileges
    // change, so a session fixation attempt with a pre-planted cookie dies here.
    const returnTo = req.session.returnTo;
    return req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = user.id;
      rotateCsrf(req);
      audit(req, 'auth.login.success', { userId: user.id });
      req.session.save(() => {
        const dest = typeof returnTo === 'string' && /^\/[^/\\]/.test(returnTo) ? returnTo : '/members';
        res.redirect(dest);
      });
    });
  })
);

router.post('/logout', requireAuth, (req, res) => {
  const userId = req.user.id;
  audit(req, 'auth.logout', { userId });
  req.session.destroy(() => {
    res.clearCookie(config.session.cookieName, { path: '/' });
    res.redirect('/?signedout=1');
  });
});

/** Signs out every other browser -- useful after using a shared computer. */
router.post('/logout-everywhere', requireAuth, (req, res) => {
  destroyUserSessions(req.user.id, { except: req.sessionID });
  audit(req, 'auth.logout.everywhere', { userId: req.user.id });
  req.flash('success', 'Every other signed-in device has been signed out.');
  req.session.save(() => res.redirect('/members/account'));
});

/* -------------------------------------------------------- password reset */

router.get('/forgot', redirectIfAuthed, (req, res) => {
  res.render('pages/forgot.njk', {
    title: 'Reset your password',
    form: {},
    sent: req.query.sent === '1',
    robots: 'noindex',
  });
});

router.post(
  '/forgot',
  redirectIfAuthed,
  passwordResetLimiter,
  asyncRoute(async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const user = Users.findByEmail(email);

    // Always the same outcome, whether or not the address exists. The response
    // page never confirms or denies that an account is registered.
    if (user && user.status !== 'suspended') {
      const raw = Users.createPasswordResetToken(user.id, null);
      const link = absoluteUrl(`/reset/${raw}`);
      await sendMail({
        to: user.email,
        ...passwordResetEmail({
          name: user.first_name,
          link,
          ttlMinutes: config.auth.resetTokenTtlMinutes,
        }),
      });
      audit(req, 'auth.reset.requested', { userId: user.id });
    } else {
      audit(req, 'auth.reset.unknownEmail');
    }

    return res.redirect('/forgot?sent=1');
  })
);

router.get('/reset/:token', redirectIfAuthed, (req, res) => {
  const userId = Users.peekPasswordResetToken(req.params.token);
  if (!userId) {
    return res.status(400).render('pages/reset.njk', {
      title: 'Reset your password',
      expired: true,
      token: null,
      errors: [],
      robots: 'noindex',
    });
  }
  return res.render('pages/reset.njk', {
    title: 'Choose a new password',
    expired: false,
    token: req.params.token,
    minLength: config.auth.minPasswordLength,
    errors: [],
    robots: 'noindex',
  });
});

router.post(
  '/reset/:token',
  redirectIfAuthed,
  passwordResetLimiter,
  asyncRoute(async (req, res) => {
    const token = req.params.token;
    const password = String(req.body.password ?? '');
    const confirm = String(req.body.confirm ?? '');

    // Peek first so a weak-password retry does not burn the single-use token.
    const userId = Users.peekPasswordResetToken(token);
    if (!userId) {
      return res.status(400).render('pages/reset.njk', {
        title: 'Reset your password',
        expired: true,
        token: null,
        errors: [],
        robots: 'noindex',
      });
    }
    const user = Users.findById(userId);

    const errors = [];
    if (password !== confirm) errors.push('The two passwords do not match.');

    const strength = checkPasswordStrength(password, {
      email: user.email,
      name: `${user.first_name} ${user.last_name}`,
    });
    errors.push(...strength.problems);

    if (!errors.length && (await isBreachedPassword(password))) {
      errors.push('That password has appeared in a public breach. Please choose a different one.');
    }

    if (errors.length) {
      return res.status(400).render('pages/reset.njk', {
        title: 'Choose a new password',
        expired: false,
        token,
        minLength: config.auth.minPasswordLength,
        errors,
        robots: 'noindex',
      });
    }

    // Spend the token only once we are certain we will accept the password.
    if (!Users.consumePasswordResetToken(token)) {
      return res.status(400).render('pages/reset.njk', {
        title: 'Reset your password',
        expired: true,
        token: null,
        errors: [],
        robots: 'noindex',
      });
    }

    await Users.setPassword(userId, password);
    // A reset is also the remedy for a compromised account, so every existing
    // session for this member is revoked.
    destroyUserSessions(userId);
    audit(req, 'auth.reset.completed', { userId });

    return res.render('pages/reset-done.njk', { title: 'Password updated', robots: 'noindex' });
  })
);

/* ----------------------------------------------------------- invitations */

/**
 * An invite link creates the account's password without an administrator ever
 * choosing one. Accepting it is exactly the reset flow with a different token
 * table, so there is only one code path that can ever set a password.
 */
router.get('/invite/:token', redirectIfAuthed, (req, res) => {
  const invite = Users.consumeInvite(req.params.token);
  if (!invite) {
    return res.status(400).render('pages/reset.njk', {
      title: 'Invitation',
      expired: true,
      token: null,
      errors: [],
      invite: true,
      robots: 'noindex',
    });
  }

  let user = Users.findByEmail(invite.email);
  if (!user) {
    const [first, ...rest] = invite.email.split('@')[0].split(/[._-]/);
    user = Users.createUser({
      email: invite.email,
      firstName: first ? first[0].toUpperCase() + first.slice(1) : 'New',
      lastName: rest.length ? rest.join(' ') : 'Member',
      role: invite.role,
      status: 'pending',
    });
  }

  const raw = Users.createPasswordResetToken(user.id);
  audit(req, 'auth.invite.accepted', { userId: user.id });
  return res.redirect(`/reset/${raw}`);
});

export default router;
