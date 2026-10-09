import express from 'express';
import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { run, nowIso } from '../db/index.js';
import * as Events from '../models/events.js';
import * as Posts from '../models/posts.js';
import * as Tools from '../models/tools.js';
import * as Builds from '../models/builds.js';
import * as Applications from '../models/applications.js';
import * as Users from '../models/users.js';
import { validate, f, ValidationError } from '../lib/validate.js';
import { contactLimiter } from '../middleware/rate-limit.js';
import { asyncRoute } from '../middleware/errors.js';
import {
  sendMail,
  contactNotificationEmail,
  applicationReceivedEmail,
  applicationNotificationEmail,
} from '../lib/mailer.js';
import { hashIp } from '../lib/tokens.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

/* ------------------------------------------------------------------- home */

router.get('/', (req, res) => {
  const next = Events.nextEvent();
  const upcoming = Events.upcomingEvents({ limit: 4 });
  const recent = Events.pastEvents({ limit: 3 });
  const news = Posts.listPosts({ viewer: null, limit: 3 });

  res.render('pages/home.njk', {
    title: 'Welcome',
    metaDescription:
      'EAA Chapter 1699 is a community of builders, pilots and dreamers at South Albany Airport (4B0) in Selkirk, New York. Fly-in breakfasts, Young Eagles rides, and a hangar full of people happy to help.',
    nextEvent: next,
    upcoming: upcoming.filter((e) => e.id !== next?.id).slice(0, 3),
    recentEvents: recent,
    news,
    stats: Tools.lockerStats(),
    builds: Builds.listBuilds({ viewer: req.user, limit: 3 }),
    buildStats: Builds.buildStats({ viewer: req.user }),
    statusLabels: Builds.STATUS_LABELS,
  });
});

router.get('/about', (req, res) => {
  res.render('pages/about.njk', {
    title: 'Who we are',
    metaDescription:
      'Who we are: EAA Chapter 1699, the Experimental Aircraft Association chapter at South Albany Airport in Selkirk, NY.',
  });
});

/* ----------------------------------------------------------------- events */

router.get('/events', (req, res) => {
  const events = Events.upcomingEvents({
    limit: 25,
    includeDrafts: req.user?.role === 'editor' || req.user?.role === 'admin',
  });
  res.render('pages/events.njk', {
    title: 'Upcoming events',
    metaDescription:
      'Fly-in breakfasts, Young Eagles rallies, workshops and monthly meetings at South Albany Airport (4B0).',
    events,
  });
});

router.get('/events/past', (req, res) => {
  const year = /^\d{4}$/.test(String(req.query.year)) ? String(req.query.year) : null;
  const events = Events.pastEvents({ limit: 40, year });
  res.render('pages/events-past.njk', {
    title: 'Past events',
    metaDescription: 'Photos and write-ups from EAA Chapter 1699 events gone by.',
    events,
    years: Events.pastEventYears(),
    activeYear: year,
  });
});

/** Subscribable calendar feed: ForeFlight, Google Calendar, Outlook, Apple. */
router.get('/events/calendar.ics', (req, res) => {
  const events = [...Events.upcomingEvents({ limit: 100 }), ...Events.pastEvents({ limit: 100 })];
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="eaa1699.ics"');
  res.send(Events.toIcs(events, { baseUrl: absoluteUrl('') }));
});

router.get('/events/:slug', (req, res, next) => {
  const event = Events.getEventBySlug(req.params.slug, { viewer: req.user });
  if (!event) return next();
  res.render('pages/event-detail.njk', {
    title: event.title,
    metaDescription: event.summary,
    ogImage: event.poster_path ? `/media/${event.poster_path}` : null,
    event,
    isPast: new Date(event.ends_at || event.starts_at) < new Date(),
  });
});

/* ---------------------------------------------------------------- contact */

router.get('/contact', (req, res) => {
  res.render('pages/contact.njk', {
    title: 'Contact us',
    metaDescription:
      'Get in touch with EAA Chapter 1699 at South Albany Airport (4B0), Selkirk NY.',
    form: {},
    errors: {},
    sent: req.query.sent === '1',
  });
});

router.post(
  '/contact',
  contactLimiter,
  asyncRoute(async (req, res) => {
    const rerender = (errors, form) =>
      res.status(400).render('pages/contact.njk', {
        title: 'Contact us',
        form,
        errors,
      });

    // Two silent spam checks. The honeypot is a field hidden with CSS that a
    // human never sees and a naive bot always fills. The timestamp check
    // rejects submissions that arrive implausibly fast for a typed message.
    if (String(req.body.website ?? '').trim() !== '') {
      audit(req, 'contact.honeypot');
      return res.redirect('/contact?sent=1'); // pretend it worked
    }
    const renderedAt = Number(req.body.rendered_at);
    if (Number.isFinite(renderedAt) && Date.now() - renderedAt < 2500) {
      audit(req, 'contact.tooFast');
      return res.redirect('/contact?sent=1');
    }

    let data;
    try {
      data = validate(req.body, {
        name: f.string({ min: 2, max: 100, label: 'Name' }),
        email: f.email(),
        topic: f.enum(
          ['General question', 'Visiting / fly-in', 'Young Eagles flight', 'Joining the chapter', 'Building help', 'Something else'],
          { label: 'Topic', fallback: 'General question' }
        ),
        message: f.string({ min: 10, max: 4000, label: 'Message' }),
      });
    } catch (err) {
      if (err instanceof ValidationError) return rerender(err.errors, req.body);
      throw err;
    }

    run(
      `INSERT INTO contact_messages (name, email, topic, message, ip_hash, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.name,
        data.email,
        data.topic,
        data.message,
        hashIp(req.ip, config.secrets.session),
        String(req.get('user-agent') ?? '').slice(0, 300),
        nowIso(),
      ]
    );

    await sendMail({
      to: config.site.contactEmail,
      // So an officer can just hit reply. Safe to expose here in a way it is
      // not in the Tool Locker: the sender gave this address for the express
      // purpose of being replied to.
      replyTo: data.email,
      ...contactNotificationEmail(data),
    });

    audit(req, 'contact.received', { entity: 'contact_message' });
    return res.redirect('/contact?sent=1');
  })
);

/* ------------------------------------------------- membership requests */

router.get('/join', (req, res) => {
  if (req.user) return res.redirect('/members');
  return res.render('pages/join.njk', {
    title: 'Request a members account',
    metaDescription:
      'Ask for a Members Corner account at EAA Chapter 1699 — the chapter blog, the Tool Locker and members’ build logs.',
    form: {},
    errors: {},
    interests: Applications.INTERESTS,
    sent: req.query.sent === '1',
  });
});

router.post(
  '/join',
  contactLimiter,
  asyncRoute(async (req, res) => {
    if (req.user) return res.redirect('/members');

    // Same two silent spam checks as the contact form.
    if (String(req.body.website ?? '').trim() !== '') {
      audit(req, 'application.honeypot');
      return res.redirect('/join?sent=1');
    }
    const renderedAt = Number(req.body.rendered_at);
    if (Number.isFinite(renderedAt) && Date.now() - renderedAt < 3000) {
      audit(req, 'application.tooFast');
      return res.redirect('/join?sent=1');
    }

    let data;
    try {
      data = validate(req.body, {
        first_name: f.string({ min: 1, max: 60, label: 'First name' }),
        last_name: f.string({ min: 1, max: 60, label: 'Last name' }),
        email: f.email(),
        phone: f.phone(),
        eaa_number: f.optionalString({ max: 20, label: 'EAA number' }),
        aircraft: f.optionalString({ max: 120, label: 'Aircraft' }),
        home_base: f.optionalString({ max: 80, label: 'Home airport' }),
        interest: f.enum(Applications.INTERESTS, { label: 'What brings you here', optional: true }),
        message: f.string({ min: 10, max: 2000, label: 'About you' }),
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('pages/join.njk', {
          title: 'Request a members account',
          form: req.body,
          errors: err.errors,
          interests: Applications.INTERESTS,
        });
      }
      throw err;
    }

    // An address that already has an account never reaches the review queue:
    // otherwise anyone could fill an administrator's inbox with requests for
    // addresses they merely suspect are members. The redirect below is the
    // same in every branch, so nothing about which case applied is observable.
    const applicationId = Users.findByEmail(data.email)
      ? null
      : Applications.createApplication({
          firstName: data.first_name,
          lastName: data.last_name,
          email: data.email,
          phone: data.phone,
          eaaNumber: data.eaa_number,
          aircraft: data.aircraft,
          homeBase: data.home_base,
          interest: data.interest,
          message: data.message,
          ipHash: hashIp(req.ip, config.secrets.session),
          userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
        });

    if (applicationId) {
      await sendMail({
        to: data.email,
        ...applicationReceivedEmail({ name: data.first_name }),
      });
      await sendMail({
        to: config.site.contactEmail,
        replyTo: data.email,
        ...applicationNotificationEmail({
          name: `${data.first_name} ${data.last_name}`,
          email: data.email,
          interest: data.interest,
          message: data.message,
          link: absoluteUrl('/members/admin/applications'),
        }),
      });
      audit(req, 'application.received', {
        entity: 'membership_application',
        entityId: applicationId,
      });
    } else {
      // Already a member, or already asked and still waiting.
      audit(req, 'application.suppressed');
    }

    return res.redirect('/join?sent=1');
  })
);

/* ------------------------------------------------------------ boilerplate */

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Disallow: /members/', 'Disallow: /login', 'Disallow: /reset', '', `Sitemap: ${absoluteUrl('/sitemap.xml')}`].join('\n')
  );
});

router.get('/sitemap.xml', (req, res) => {
  const urls = [
    { loc: '/', priority: '1.0' },
    { loc: '/about', priority: '0.8' },
    { loc: '/events', priority: '0.9' },
    { loc: '/events/past', priority: '0.6' },
    { loc: '/builds', priority: '0.8' },
    { loc: '/contact', priority: '0.7' },
    { loc: '/join', priority: '0.5' },
    ...Builds.listBuilds({ viewer: null, limit: 200 }).map((b) => ({
      loc: `/builds/${b.slug}`,
      priority: '0.6',
    })),
    ...Events.upcomingEvents({ limit: 100 }).map((e) => ({ loc: `/events/${e.slug}`, priority: '0.8' })),
    ...Events.pastEvents({ limit: 100 }).map((e) => ({ loc: `/events/${e.slug}`, priority: '0.4' })),
  ];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (u) => `  <url><loc>${absoluteUrl(u.loc)}</loc><priority>${u.priority}</priority></url>`
    ),
    '</urlset>',
  ].join('\n');
  res.type('application/xml').send(xml);
});

router.get('/healthz', (req, res) => res.json({ ok: true, version: 1 }));

export default router;
