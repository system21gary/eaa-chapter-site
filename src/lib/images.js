import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import config from '../config.js';

/**
 * Uploaded image handling.
 *
 * Every uploaded file is treated as hostile:
 *  1. It is accepted into memory only, never written with a client-supplied
 *     name -- so path traversal ("../../server.js") is impossible.
 *  2. The magic bytes are checked, not the Content-Type header or extension.
 *  3. It is fully re-encoded by sharp. This is the important one: a decode +
 *     re-encode discards EXIF (including GPS coordinates of a member's home),
 *     any appended payload, and polyglot files that are simultaneously a valid
 *     JPEG and a valid script.
 *  4. The result is stored outside the static web root under a random name and
 *     served back through a route that pins the Content-Type.
 */
const MAGIC = [
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, second: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { ext: 'avif', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
];

export function sniffImageType(buffer) {
  for (const sig of MAGIC) {
    const at = sig.offset ?? 0;
    if (buffer.length < at + sig.bytes.length) continue;
    const head = buffer.subarray(at, at + sig.bytes.length);
    if (!sig.bytes.every((b, i) => head[i] === b)) continue;
    if (sig.second) {
      const s = buffer.subarray(sig.second.at, sig.second.at + sig.second.bytes.length);
      if (!sig.second.bytes.every((b, i) => s[i] === b)) continue;
    }
    return sig.ext;
  }
  return null;
}

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'EIMAGE';
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Processes one upload into a full-size and thumbnail WebP pair.
 * Returns paths relative to the upload root, which is what we store in the DB.
 */
export async function processImage(buffer, { folder = 'misc' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ImageError('That file was empty.');
  }
  if (buffer.length > config.uploads.maxBytes) {
    throw new ImageError(
      `Images must be under ${Math.round(config.uploads.maxBytes / 1024 / 1024)} MB.`
    );
  }
  if (!sniffImageType(buffer)) {
    throw new ImageError('That does not look like a JPEG, PNG, GIF, WebP or AVIF image.');
  }

  // `limitInputPixels` caps decompression-bomb images (a 100k x 100k PNG that
  // expands to tens of gigabytes) before they can exhaust memory.
  const base = sharp(buffer, { limitInputPixels: 50_000_000, sequentialRead: true });

  let meta;
  try {
    meta = await base.metadata();
  } catch {
    throw new ImageError('That image could not be read. Try re-saving it and uploading again.');
  }
  if (!meta.width || !meta.height) throw new ImageError('That image has no usable dimensions.');

  const safeFolder = String(folder).replace(/[^a-z0-9-]/gi, '') || 'misc';
  const stamp = new Date();
  const relDir = path.join(
    safeFolder,
    String(stamp.getUTCFullYear()),
    String(stamp.getUTCMonth() + 1).padStart(2, '0')
  );
  const absDir = path.join(config.uploadDir, relDir);
  await ensureDir(absDir);

  const id = crypto.randomBytes(16).toString('hex');
  const fullRel = path.join(relDir, `${id}.webp`);
  const thumbRel = path.join(relDir, `${id}-thumb.webp`);

  const full = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate() // honour EXIF orientation before we throw the EXIF away
    .resize({
      width: config.uploads.fullWidth,
      height: config.uploads.fullWidth,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  const thumb = await sharp(buffer, { limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: config.uploads.thumbWidth, height: config.uploads.thumbWidth, fit: 'cover', position: 'attention' })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();

  await fs.writeFile(path.join(config.uploadDir, fullRel), full.data);
  await fs.writeFile(path.join(config.uploadDir, thumbRel), thumb);

  return {
    fullPath: fullRel.split(path.sep).join('/'),
    thumbPath: thumbRel.split(path.sep).join('/'),
    width: full.info.width,
    height: full.info.height,
    bytes: full.data.length,
  };
}

/** Deletes stored derivatives, ignoring files that are already gone. */
export async function deleteImage(...relPaths) {
  for (const rel of relPaths.filter(Boolean)) {
    const abs = resolveUploadPath(rel);
    if (!abs) continue;
    await fs.rm(abs, { force: true });
  }
}

/**
 * Resolves a stored relative path to an absolute one, refusing anything that
 * escapes the upload root. This is the guard on the file-serving route.
 */
export function resolveUploadPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return null;
  if (relPath.includes('\0')) return null; // reject NUL-byte path truncation
  const root = path.resolve(config.uploadDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
