import config from '../config.js';

export function notFound(req, res, next) {
  const err = new Error('We could not find that page.');
  err.status = 404;
  next(err);
}

const FRIENDLY = {
  400: 'Something in that request was not quite right.',
  403: 'You do not have access to that.',
  404: 'We could not find that page.',
  413: 'That upload is larger than we can accept.',
  429: 'Too many requests. Please wait a moment.',
  500: 'Something broke on our end. The webmaster has been notified.',
};

/**
 * Central error handler.
 *
 * In production the client sees a friendly sentence and nothing else -- no
 * stack traces, no SQL, no file paths, because those are a reconnaissance gift
 * to an attacker. The full error still goes to the server log.
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status = Number(err.status) || 500;
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  } else if (config.isDev) {
    console.warn(`[${status}] ${req.method} ${req.originalUrl} - ${err.message}`);
  }

  const message = status >= 500 && config.isProd ? FRIENDLY[500] : err.message || FRIENDLY[status];

  // Validation failures re-render the form the member was filling in rather
  // than throwing their work away on an error page.
  if (err.code === 'EVALIDATION' && err.rerender) {
    return err.rerender(res, err.errors);
  }

  res.status(status);
  if (req.accepts('html')) {
    // The error page is the last thing standing; if even it fails to render,
    // fall back to plain text rather than handing the client a second,
    // uncaught exception.
    return res.render(
      'pages/error.njk',
      {
        title: `${status}`,
        status,
        message,
        detail: config.isDev && status >= 500 ? err.stack : null,
      },
      (renderErr, html) => {
        if (renderErr) {
          console.error('[error] the error page itself failed to render', renderErr);
          return res.type('text/plain').send(message);
        }
        return res.send(html);
      }
    );
  }
  return res.json({ error: message });
}

/** Wraps an async route so a rejected promise reaches the error handler. */
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
