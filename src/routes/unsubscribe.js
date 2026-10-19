import express from 'express';
import * as Users from '../models/users.js';
import { readToken } from '../lib/unsubscribe.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { audit } from '../lib/audit.js';

/**
 * One-click unsubscribe. Public on purpose: see lib/unsubscribe.js. The page a
 * person lands on asks them to confirm (so a mail scanner that merely fetches
 * the link does not unsubscribe anybody); a mail client's own button POSTs
 * straight to the same address and is treated as the confirmation.
 */
const router = express.Router();

const show = (res, view) =>
  res.set('Cache-Control', 'no-store').render('pages/unsubscribe.njk', {
    title: 'Email preferences',
    robots: 'noindex',
    ...view,
  });

function resolve(req) {
  const t = readToken(req.params.token);
  if (!t || !Users.findById(t.userId)) return null;
  return { ...t, label: Users.MAIL_PREFS[t.column].label };
}

router.get('/:token', (req, res) => {
  const t = resolve(req);
  if (!t) return show(res.status(404), { state: 'invalid' });
  return show(res, { state: 'confirm', label: t.label, token: req.params.token });
});

router.post('/:token', writeLimiter, (req, res) => {
  const t = resolve(req);
  if (!t) return show(res.status(404), { state: 'invalid' });
  Users.setMailPref(t.userId, t.column, false);
  audit(req, 'member.mailpref.unsubscribed', { userId: t.userId, entity: 'user', entityId: t.userId, detail: t.category });
  return show(res, { state: 'done', label: t.label, token: req.params.token });
});

router.post('/:token/resubscribe', writeLimiter, (req, res) => {
  const t = resolve(req);
  if (!t) return show(res.status(404), { state: 'invalid' });
  Users.setMailPref(t.userId, t.column, true);
  audit(req, 'member.mailpref.resubscribed', { userId: t.userId, entity: 'user', entityId: t.userId, detail: t.category });
  return show(res, { state: 'back', label: t.label, token: req.params.token });
});

export default router;
