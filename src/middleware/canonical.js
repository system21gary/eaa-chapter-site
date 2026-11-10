/**
 * One address per page. `/events/`, `/Events` and `/events` all reached the
 * same handler (Express routing is case-insensitive and ignores a trailing
 * slash), so search engines saw several copies of every page. GET and HEAD
 * requests for a variant get a permanent redirect to the clean path; the
 * query string comes along unchanged.
 *
 * Lower-casing is limited to the public pages: token URLs such as
 * /reset/<token> and /unsubscribe/<token> are case-sensitive and must never
 * be rewritten.
 */
const PUBLIC_SECTIONS = /^\/(events|builds|about|contact|join)(\/|$)/i;

export function canonicalRedirect(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const path = req.path;
  let clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (PUBLIC_SECTIONS.test(clean) && clean !== clean.toLowerCase()) clean = clean.toLowerCase();
  if (!clean) clean = '/';
  if (clean === path) return next();
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  return res.redirect(301, clean + query);
}
