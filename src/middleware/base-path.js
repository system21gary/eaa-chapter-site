import config from '../config.js';

/**
 * Serving the site under a path prefix (BASE_PATH).
 *
 * Two independent things have to line up:
 *
 *  1. **Incoming** requests may or may not still carry the prefix, depending on
 *     whether the proxy strips it. code-server's `/proxy/<port>/` strips it;
 *     its `/absproxy/<port>/` does not, and neither do most path-based reverse
 *     proxy configurations. Stripping it here when it is present means routes
 *     are written once, against a root, and work under either style.
 *
 *  2. **Outgoing** URLs must include the prefix, or the browser resolves them
 *     against the domain root and fetches nothing -- which is exactly what an
 *     unstyled page is: the HTML arrived, `/assets/css/site.css` did not.
 *     That is what the `url`, `asset` and `media` template filters do, plus
 *     the redirect wrapper below.
 *
 * The prefix comes from configuration only, never from a request header.
 * Trusting something like `X-Forwarded-Prefix` would let any client rewrite
 * every link on the page, and there is no need for it: the deployment knows
 * its own path.
 */
export function basePathMiddleware(req, res, next) {
  const prefix = config.basePath;
  res.locals.basePath = prefix;

  if (prefix) {
    if (req.url === prefix) {
      req.url = '/';
    } else if (req.url.startsWith(`${prefix}/`)) {
      req.url = req.url.slice(prefix.length);
    }

    // Rewrite outgoing redirects to match. See config.redirectMode.
    if (config.redirectMode === 'plain') return next();

    const redirect = res.redirect.bind(res);
    res.redirect = (...args) => {
      const target = args.pop();
      const isLocalPath =
        typeof target === 'string' && target.startsWith('/') && !target.startsWith('//');
      if (!isLocalPath) return redirect(...args, target);
      return redirect(
        ...args,
        config.redirectMode === 'absolute' ? absoluteUrl(target) : `${prefix}${target}`
      );
    };
  }

  next();
}

/**
 * Prefixes a root-relative path. Leaves absolute and protocol-relative URLs
 * alone.
 *
 * An empty argument yields the prefix on its own, which is what templates use
 * when the rest of the path is built from an expression:
 *   href="{{ '' | url }}/builds/{{ build.slug }}"
 */
export function withBase(path) {
  const p = String(path ?? '');
  if (!config.basePath) return p;
  if (p === '') return config.basePath;
  if (!p.startsWith('/') || p.startsWith('//')) return p;
  return `${config.basePath}${p}`;
}

/**
 * A fully-qualified URL for a root-relative path, including the base path.
 *
 * Used for links that leave the site and have to work when pasted back in:
 * password resets, invitations, the sitemap, the calendar feed. Getting this
 * wrong is silent -- the email sends, the link 404s.
 */
export function absoluteUrl(path) {
  return `${config.site.baseUrl.replace(/\/+$/, '')}${withBase(path)}`;
}
