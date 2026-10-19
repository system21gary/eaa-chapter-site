import express from 'express';
import session from 'express-session';
import compression from 'compression';
import nunjucks from 'nunjucks';

import config from './config.js';
import { migrate } from './db/migrate.js';
import { SqliteSessionStore } from './lib/session-store.js';
import { csrfProtection, auditDeferredCsrf } from './lib/csrf.js';
import { cspNonce, securityHeaders, extraHeaders, verifyOrigin, bodyLimits } from './middleware/security.js';
import { basePathMiddleware } from './middleware/base-path.js';
import { generalLimiter } from './middleware/rate-limit.js';
import { loadUser, flashMiddleware } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { registerFilters } from './views/filters.js';
import { pendingCount as pendingApplicationCount } from './models/applications.js';
import { statsMiddleware, pingHandler } from './lib/stats.js';
import { statsLimiter } from './middleware/rate-limit.js';
import { waitingCount as waitingMessageCount } from './models/contact.js';
import { pendingRequestCount as pendingToolRequestCount } from './models/tools.js';
import { BOARD_ROLES, MAIL_PREFS, canApprove } from './models/users.js';
import { pendingReviewCount as documentsInReview } from './models/documents.js';

import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import membersRoutes from './routes/members.js';
import blogRoutes from './routes/blog.js';
import lockerRoutes from './routes/locker.js';
import buildsRoutes from './routes/builds.js';
import memberBuildsRoutes from './routes/member-builds.js';
import adminRoutes from './routes/admin.js';
import documentsRoutes from './routes/documents.js';
import unsubscribeRoutes from './routes/unsubscribe.js';
import scheduleRoutes from './routes/schedule.js';
import mediaRoutes from './routes/media.js';

export function createApp() {
  migrate({ quiet: true });

  const app = express();

  // Only trust proxy headers when we know we are behind one; trusting them
  // blindly lets a client spoof X-Forwarded-For and defeat rate limiting.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  /* ------------------------------------------------------------ templates */
  const env = nunjucks.configure(config.viewsDir, {
    autoescape: true, // every `{{ }}` is HTML-escaped unless explicitly marked
    express: app,
    // `watch` needs chokidar, which we do not depend on. noCache alone gives
    // the same edit-and-refresh behaviour in development.
    watch: false,
    noCache: config.isDev,
    throwOnUndefined: false,
  });
  registerFilters(env);
  app.set('view engine', 'njk');

  /* ------------------------------------------------------------- security */
  // Must run before anything that looks at the path: it strips the BASE_PATH
  // prefix from incoming requests and prefixes outgoing redirects.
  app.use(basePathMiddleware);

  app.use(cspNonce);
  app.use(securityHeaders());
  app.use(extraHeaders);

  // Template globals that depend on nothing but the request are set up front,
  // so the error page can still render its nav when something is rejected
  // before the session or auth middleware has run (a CSRF or Origin refusal,
  // for instance).
  app.use((req, res, next) => {
    res.locals.site = config.site;
    res.locals.currentPath = req.path || '/';
    res.locals.isDev = config.isDev;
    res.locals.currentUser = null;
    res.locals.csrfToken = '';
    res.locals.pendingApplications = 0;
    res.locals.statsEnabled = config.stats.enabled;
    res.locals.waitingMessages = 0;
    res.locals.pendingToolRequests = 0;
    next();
  });
  app.use(compression());
  app.use(generalLimiter);

  /* --------------------------------------------------------------- static */
  app.use(
    '/assets',
    express.static(config.publicDir, {
      maxAge: config.isProd ? '30d' : 0,
      etag: true,
      index: false,
      dotfiles: 'ignore',
      // Never let a stray .html in /public be served as a document with our
      // origin's privileges.
      setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
    })
  );

  /* ---------------------------------------------------------------- input */
  app.use(express.urlencoded({ extended: false, limit: bodyLimits.urlencoded }));
  app.use(express.json({ limit: bodyLimits.json }));

  /* -------------------------------------------------------------- session */
  app.use(
    session({
      name: config.session.cookieName,
      secret: config.secrets.session,
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false, // no cookie until there is something to remember
      rolling: true,
      proxy: config.trustProxy > 0,
      cookie: {
        httpOnly: true, // unreadable from JavaScript, so XSS cannot steal it
        sameSite: 'lax', // blocks cross-site POSTs carrying the cookie
        secure: config.session.secureCookies,
        maxAge: config.session.maxAgeMs,
        // Deliberately '/', not BASE_PATH. express-session skips the request
        // entirely when the incoming pathname does not start with the cookie
        // path -- and under a proxy that strips the prefix (code-server's
        // /proxy/<port>/, most nginx location blocks) the app sees "/reset/x"
        // while the browser sees "/prefix/reset/x". Scoping to the prefix
        // therefore means no session, no CSRF token, and a 403 on every form.
        // One value cannot satisfy both sides, so the broad one wins.
        path: '/',
      },
    })
  );

  app.use(verifyOrigin);
  app.use(loadUser);
  // The page's time-on-page report. Mounted before the CSRF and flash layers on purpose: it changes
  // no one's data and must never create a session. It is guarded by the origin check above, a
  // rate limit, a size limit and strict validation instead.
  app.post('/stats/ping', statsLimiter, express.text({ type: () => true, limit: '1kb' }), pingHandler);
  app.use(flashMiddleware);
  app.use(statsMiddleware);
  app.use(csrfProtection);
  app.use(auditDeferredCsrf);

  /* --------------------------------------------- view globals (post-auth) */
  app.use((req, res, next) => {
    res.locals.boardRoles = BOARD_ROLES;
    res.locals.mailPrefs = MAIL_PREFS;
    // Badge count for the admin nav. Cheap indexed COUNT, and only computed
    // for admins actually inside the members area.
    if (req.user?.role === 'admin' && req.path.startsWith('/members')) {
      res.locals.pendingApplications = pendingApplicationCount();
    }
    // Badge for the President and Vice President: documents waiting on a decision.
    if (canApprove(req.user) && req.path.startsWith('/members')) {
      res.locals.documentsToReview = documentsInReview();
    }
    // Tool loan requests waiting on this member to answer, for the Tool Locker tab.
    if (req.user && req.path.startsWith('/members')) {
      res.locals.pendingToolRequests = pendingToolRequestCount(req.user.id);
    }
    // The Inbox is open to editors as well, so its count is too.
    if (['editor', 'admin'].includes(req.user?.role) && req.path.startsWith('/members')) {
      res.locals.waitingMessages = waitingMessageCount();
    }
    next();
  });

  /* --------------------------------------------------------------- routes */
  app.use('/', publicRoutes);
  app.use('/', authRoutes);
  app.use('/builds', buildsRoutes);
  app.use('/media', mediaRoutes);
  app.use('/members', membersRoutes);
  app.use('/members/builds', memberBuildsRoutes);
  app.use('/members/blog', blogRoutes);
  app.use('/members/locker', lockerRoutes);
  app.use('/unsubscribe', unsubscribeRoutes);
  app.use('/members/documents', documentsRoutes);
  app.use('/members/admin/schedule', scheduleRoutes);
  app.use('/members/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
