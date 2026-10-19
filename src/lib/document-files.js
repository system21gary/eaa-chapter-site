import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { sniffImageType } from './images.js';

/**
 * Stored chapter documents (minutes, financial reports, newsletters...).
 *
 * Same stance as image uploads: the file is hostile until proven otherwise.
 *  - Accepted into memory, never written under a client-supplied name.
 *  - The type comes from the file's contents, not its extension or
 *    Content-Type, and the extension has to agree with the contents.
 *  - Only a short allow-list of types is accepted. Macro-enabled Office files
 *    and the old binary .doc/.xls/.ppt formats are refused, since those are
 *    how documents carry malware.
 *  - Stored outside the web root under a random name and served back only to
 *    people allowed to see them, always as a download, never rendered.
 */

export class DocumentError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'EDOCUMENT';
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const OFFICE = {
  docx: { marker: 'word/document.xml', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { marker: 'xl/workbook.xml', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { marker: 'ppt/presentation.xml', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

export const ALLOWED_LABEL = 'PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, text, PNG, JPEG or WebP';

const startsWith = (buf, bytes) => buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);

/**
 * Works out what a file really is. Returns `{ ext, mime }` or throws a
 * DocumentError that is fit to show to the person who uploaded it.
 */
export function detectDocumentType(buffer, filename) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new DocumentError('That file was empty.');
  if (buffer.length > config.documents.maxBytes) {
    throw new DocumentError(`Files must be under ${Math.round(config.documents.maxBytes / 1024 / 1024)} MB.`);
  }

  const claimed = path.extname(String(filename ?? '')).slice(1).toLowerCase();
  const kind = claimed === 'jpeg' ? 'jpg' : claimed;

  if (startsWith(buffer, OLE_MAGIC)) {
    throw new DocumentError('Old-style Word, Excel and PowerPoint files (.doc, .xls, .ppt) are not accepted. Save it as .docx, .xlsx or .pptx, or as a PDF.');
  }

  if (kind === 'pdf') {
    if (buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) return { ext: 'pdf', mime: 'application/pdf' };
    throw new DocumentError('That file is named .pdf but is not a PDF.');
  }

  if (OFFICE[kind]) {
    if (!startsWith(buffer, ZIP_MAGIC)) throw new DocumentError(`That file is named .${kind} but is not a ${kind.toUpperCase()} document.`);
    if (buffer.includes('vbaProject.bin')) throw new DocumentError('Files that contain macros are not accepted. Save a copy without macros.');
    if (!buffer.includes(OFFICE[kind].marker)) throw new DocumentError(`That file is named .${kind} but is not a ${kind.toUpperCase()} document.`);
    return { ext: kind, mime: OFFICE[kind].mime };
  }

  if (kind === 'png' || kind === 'jpg' || kind === 'webp') {
    const real = sniffImageType(buffer);
    if (real !== kind) throw new DocumentError(`That file is named .${claimed} but its contents are ${real ? `a ${real.toUpperCase()} image` : 'not an image'}.`);
    return { ext: kind, mime: kind === 'jpg' ? 'image/jpeg' : `image/${kind}` };
  }

  if (kind === 'csv' || kind === 'txt') {
    if (buffer.includes(0)) throw new DocumentError(`That file is named .${kind} but is not plain text.`);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      throw new DocumentError(`That .${kind} file is not UTF-8 text. Save it as UTF-8, or as a PDF.`);
    }
    return { ext: kind, mime: kind === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8' };
  }

  throw new DocumentError(`That type of file is not accepted. Use ${ALLOWED_LABEL}.`);
}

/** A display and download name that cannot carry a path or control characters. */
export function safeFilename(name) {
  const base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  const cleaned = base.replace(/[^\w.\- ()]/gu, '_').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  return (cleaned || 'document').slice(0, 120);
}

const STORED_RE = /^[a-f0-9]{32}$/;

function storedPath(storedName) {
  if (!STORED_RE.test(storedName)) return null;
  return path.join(config.documents.dir, storedName);
}

/** Validates and writes one upload. Returns what the database needs to remember. */
export async function storeDocument(buffer, originalName) {
  const type = detectDocumentType(buffer, originalName);
  const storedName = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(config.documents.dir, { recursive: true });
  await fs.writeFile(storedPath(storedName), buffer, { flag: 'wx', mode: 0o600 });
  return {
    storedName,
    originalName: safeFilename(originalName),
    mime: type.mime,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

export function documentPath(storedName) {
  return storedPath(storedName);
}

export async function deleteDocumentFile(storedName) {
  const p = storedPath(storedName);
  if (p) await fs.rm(p, { force: true });
}
