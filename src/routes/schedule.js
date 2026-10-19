import express from 'express';
import config from '../config.js';
import * as Users from '../models/users.js';
import { requireAdmin } from '../middleware/auth.js';
import { writeLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import { audit } from '../lib/audit.js';
import * as Scheduler from '../lib/scheduler.js';

/**
 * Scheduled emails: what the site is about to send on its own, with a way to
 * skip an item, send yourself a test copy, or pause everything. Administrators only:
 * this is the running of the site, like the activity log and the people list.
 */
const router = express.Router();
router.use(requireAdmin);

const back = (req, res, type, message) => {
  req.flash(type, message);
  return req.session.save(() => res.redirect('/members/admin/schedule'));
};

router.get('/', (req, res) => {
  res.render('members/schedule.njk', {
    title: 'Scheduled emails',
    robots: 'noindex',
    items: Scheduler.plan(),
    recent: Scheduler.recentSends(),
    audience: Scheduler.audience(),
    totalMembers: Users.listMembers({ status: 'active' }).length,
    paused: Scheduler.isPaused(),
    enabled: config.scheduler.enabled,
    reminderHour: config.scheduler.reminderHour,
    rules: Scheduler.RULES,
  });
});

router.post('/pause', writeLimiter, (req, res) => {
  const paused = req.body.paused === '1';
  Scheduler.setPaused(paused);
  audit(req, paused ? 'scheduler.paused' : 'scheduler.resumed');
  return back(req, res, 'success', paused ? 'Paused. Nothing will be sent until you resume.' : 'Resumed.');
});

router.post('/skip', writeLimiter, (req, res) => {
  const key = String(req.body.key ?? '');
  const ok = req.body.undo === '1' ? Scheduler.unskip(key) : Scheduler.skip(key, req.user);
  if (!ok) return back(req, res, 'error', 'That one cannot be changed any more.');
  audit(req, req.body.undo === '1' ? 'scheduler.unskipped' : 'scheduler.skipped', { detail: key });
  return back(req, res, 'success', req.body.undo === '1' ? 'Restored. It will go out as planned.' : 'Skipped. It will not be sent.');
});

router.post(
  '/test',
  writeLimiter,
  asyncRoute(async (req, res) => {
    const item = Scheduler.plan().find((p) => p.key === String(req.body.key ?? ''));
    if (!item) return back(req, res, 'error', 'That one is no longer scheduled.');
    await Scheduler.sendTest(item.event, req.user);
    audit(req, 'scheduler.test', { detail: item.key });
    return back(req, res, 'success', `A test copy is on its way to ${req.user.email}.`);
  })
);

export default router;
