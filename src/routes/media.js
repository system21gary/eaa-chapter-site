import fs from 'node:fs';
import express from 'express';
import { resolveUploadPath } from '../lib/images.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Serves processed uploads.
 *
 * These files live outside the static web root deliberately, so nothing can be
 * fetched without passing through this handler. Everything we store is WebP
 * (the image pipeline re-encodes it), so the Content-Type is pinned to
 * image/webp rather than guessed from the path -- there is no way to get the
 * server to hand back a file as text/html or application/javascript.
 */

// Folders whose contents are members-only. Anything a member uploads about
// themselves or their hangar stays behind the login.
const PRIVATE_PREFIXES = ['tools/', 'avatars/'];

router.get(/^\/(.+)$/, (req, res, next) => {
  const relPath = req.params[0];

  if (!/^[A-Za-z0-9/_-]+\.webp$/.test(relPath)) {
    return next(); // 404 via the catch-all; no directory listings, no other extensions
  }

  const abs = resolveUploadPath(relPath);
  if (!abs) return next();

  const isPrivate = PRIVATE_PREFIXES.some((p) => relPath.startsWith(p));
  if (isPrivate && !req.user) {
    return requireAuth(req, res, next);
  }

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return next();

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Cache-Control',
      isPrivate ? 'private, max-age=3600' : 'public, max-age=604800, immutable'
    );
    res.setHeader('Last-Modified', stat.mtime.toUTCString());

    fs.createReadStream(abs).on('error', next).pipe(res);
  });
});

export default router;
