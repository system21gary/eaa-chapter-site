import * as Users from '../models/users.js';
import { displayName } from '../models/users.js';

/**
 * Resolves the signed-in member for every request.
 *
 * The session holds nothing but a user id -- role and status are re-read from
 * the database on each request, so revoking access or demoting an admin takes
 * effect immediately rather than at their next login.
 */
export function loadUser(req, res, next) {
  req.user = null;
  const userId = req.session?.userId;
  if (userId) {
    const user = Users.findById(userId);
    if (!user || user.status !== 'active') {
      // Account was suspended or deleted mid-session: drop it now.
      req.session.destroy(() => next());
      return;
    }
    req.user = user;
  }
  res.locals.currentUser = req.user;
  res.locals.displayName = displayName;
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  // Remember where they were headed, but only same-site paths -- an
  // attacker-controlled `next` would otherwise turn login into an open
  // redirect.
  const target = req.originalUrl;
  req.session.returnTo = /^\/[^/\\]/.test(target) ? target : '/members';
  req.session.save(() => res.redirect('/login'));
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (roles.includes(req.user.role)) return next();
    const err = new Error('You do not have access to that area.');
    err.status = 403;
    next(err);
  };
}

/** Editors and admins can manage chapter content; admins can manage people. */
export const requireEditor = requireRole('editor', 'admin');
export const requireAdmin = requireRole('admin');

/** Owner-or-admin check used by the tool locker and blog. */
export function canManage(user, ownerId) {
  if (!user) return false;
  return user.role === 'admin' || Number(user.id) === Number(ownerId);
}

export function redirectIfAuthed(req, res, next) {
  if (req.user) return res.redirect('/members');
  next();
}

/** Consumes a one-shot flash message queued on the session. */
export function flashMiddleware(req, res, next) {
  res.locals.flash = req.session?.flash ?? null;
  if (req.session?.flash) delete req.session.flash;

  req.flash = (type, message) => {
    if (req.session) req.session.flash = { type, message };
  };
  next();
}
