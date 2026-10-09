/**
 * Members-area audit.
 *
 * Drives every create / edit / cancel / delete path in the Members Corner in a
 * real browser, with real file uploads, and checks that uploaded images
 * actually render afterwards. The HTTP-level smoke suite cannot catch the
 * things that only go wrong once a browser is involved: multipart encoding,
 * client-side form handling, images that 404 after upload, links that go
 * nowhere.
 *
 *   node scripts/members-audit.mjs
 *
 * Needs a Chrome binary and puppeteer-core:
 *   CHROME_PATH=/path/to/chrome PUPPETEER_ROOT=/path/to/node_modules/..
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as Users from '../src/models/users.js';
import { run } from '../src/db/index.js';

const require = createRequire(process.env.PUPPETEER_ROOT || '/tmp/pptr/');
const puppeteer = require('puppeteer-core');

const EXEC =
  process.env.CHROME_PATH ||
  '/tmp/pptr/.cache/chrome-headless-shell/linux-152.0.7977.42/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
/** The path portion of BASE, if it is served under a prefix. */
const PREFIX = new URL(BASE).pathname.replace(/\/+$/, '');
/** location.pathname -> a path relative to the app root. */
const rel = (p) => (PREFIX && p.startsWith(PREFIX) ? p.slice(PREFIX.length) || '/' : p);
/**
 * The audit's own administrator, created here and deleted at the end.
 *
 * It used to sign in as the chapter's real admin using whatever password the
 * smoke suite had last set, which coupled the two scripts together and meant
 * running either one changed a real person's credentials. The address is on a
 * reserved documentation domain, so no mail is ever attempted to it.
 */
const EMAIL = process.env.AUDIT_EMAIL || 'audit.test.admin@example.com';
const PASSWORD = process.env.AUDIT_PASSWORD || 'correct-horse-battery-hangar-42';

async function ensureAuditAdmin() {
  let user = Users.findByEmail(EMAIL);
  if (!user) {
    Users.createUser({
      email: EMAIL,
      firstName: 'Audit',
      lastName: 'Robot',
      role: 'admin',
      status: 'active',
    });
    user = Users.findByEmail(EMAIL);
  } else if (user.role !== 'admin' || user.status !== 'active') {
    Users.setRole(user.id, 'admin');
    run("UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    user = Users.findByEmail(EMAIL);
  }
  // Set directly: the site has no path that accepts a password without a token,
  // by design, and this account exists only for the next few minutes.
  await Users.setPassword(user.id, PASSWORD);
  return user;
}

function removeAuditAdmin() {
  const user = Users.findByEmail(EMAIL);
  if (user) run('DELETE FROM users WHERE id = ?', [user.id]);
  return !Users.findByEmail(EMAIL);
}

await ensureAuditAdmin();

/* Test images, generated once so the run needs no fixtures checked in. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'eaa-audit-'));
const IMG_A = path.join(TMP, 'photo-a.jpg');
const IMG_B = path.join(TMP, 'photo-b.png');
for (const [file, src] of [[IMG_A, '/tmp/test-photo.jpg'], [IMG_B, '/tmp/test-photo2.png']]) {
  fs.copyFileSync(src, file);
}

let pass = 0;
const failures = [];

function check(ok, label, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push({ label, detail });
    console.log(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const browser = await puppeteer.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

/* Anything the server or the browser complains about, collected per step. */
let jsErrors = [];
let httpErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') jsErrors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url().replace(BASE, '')}`);
});

function resetErrors() {
  jsErrors = [];
  httpErrors = [];
}

/** Submits the main form on the page and waits for the navigation. */
async function submitForm(selector = 'form.form-card') {
  const btn = await page.$(`${selector} button[type=submit]`);
  if (!btn) throw new Error(`no submit button in ${selector}`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }),
    btn.click(),
  ]);
}

/** The flash message and any field errors currently on the page. */
async function outcome() {
  const o = await page.evaluate(() => ({
    rawUrl: location.pathname + location.search,
    flash: document.querySelector('.flash p')?.textContent.trim() || null,
    flashKind: document.querySelector('.flash')?.className || null,
    fieldErrors: [...document.querySelectorAll('.err')].map((e) => e.textContent.trim()),
    heading: document.querySelector('h1')?.textContent.trim() || null,
    bodyStart: document.body.innerText.slice(0, 160).replace(/\s+/g, ' '),
  }));
  // A 404 renders a normal-looking page; without this an error page can pass
  // for a success just because its URL happens to contain the right words.
  o.url = rel(o.rawUrl);
  o.isError = /Off the sectional|Not for you, sorry|Something let go|Steady on/.test(o.heading || '');
  return o;
}

/** Types into a Trix editor if present, else the plain textarea. */
async function writeRich(text) {
  await page.evaluate((t) => {
    const ed = document.querySelector('trix-editor');
    if (ed) {
      ed.editor.insertString(t);
      return;
    }
    const ta = document.querySelector('[data-rich-source]');
    if (ta) ta.value = t;
  }, text);
}

/**
 * Every <img> on the page whose URL does not actually serve an image.
 *
 * Checked by fetching rather than by reading `complete`/`naturalWidth`: images
 * below the fold are lazy-loaded and legitimately have not loaded yet, which
 * made the naive version report failures that were not real.
 */
async function brokenImages() {
  return page.evaluate(async () => {
    const srcs = [...new Set([...document.images].map((i) => i.getAttribute('src')).filter(Boolean))];
    const bad = [];
    for (const src of srcs) {
      try {
        const r = await fetch(src, { method: 'GET', credentials: 'same-origin' });
        const type = r.headers.get('content-type') || '';
        if (!r.ok || !type.startsWith('image/')) bad.push(`${src} -> ${r.status} ${type}`);
      } catch (e) {
        bad.push(`${src} -> ${e.message}`);
      }
    }
    return bad;
  });
}

async function go(pathname) {
  resetErrors();
  await page.goto(`${BASE}${pathname}`, { waitUntil: 'networkidle0', timeout: 20000 });
}

/* ══════════════════════════════════════════════════════════ sign in ═══ */
section('Sign in');
await go('/login');
await page.type('#email', EMAIL);
await page.type('#password', PASSWORD);
await submitForm();
check((await outcome()).url.endsWith('/members'), 'signed in', (await outcome()).url);

/* ═══════════════════════════════════════════════ every members page ═══ */
section('Every members page loads');
const PAGES = [
  '/members',
  '/members/blog',
  '/members/blog/new',
  '/members/locker',
  '/members/locker/new',
  '/members/locker/requests',
  '/members/builds',
  '/members/builds/new',
  '/members/directory',
  '/members/account',
  '/members/admin/events',
  '/members/admin/events/new',
  '/members/admin/members',
  '/members/admin/applications',
  '/members/admin/messages',
  '/members/admin/log',
];
for (const p of PAGES) {
  await go(p);
  const o = await outcome();
  const bad = httpErrors.filter((e) => !e.startsWith('404 /favicon'));
  check(
    o.heading !== null && bad.length === 0 && jsErrors.length === 0,
    `GET ${p}`,
    [bad.join(', '), jsErrors.join(' | ')].filter(Boolean).join(' ')
  );
}

/* ═════════════════════════════════════════════════ cancel buttons ═══ */
section('Cancel links go somewhere real');
const CANCELS = [
  ['/members/blog/new', 'new post'],
  ['/members/locker/new', 'new tool'],
  ['/members/builds/new', 'new build'],
  ['/members/admin/events/new', 'new event'],
];
for (const [from, label] of CANCELS) {
  await go(from);
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === 'Cancel');
    return a ? a.getAttribute('href') : null;
  });
  if (!href) {
    check(false, `cancel on ${label}`, 'no Cancel link found');
    continue;
  }
  resetErrors();
  const res = await page.goto(new URL(href, `${BASE}/`).href, { waitUntil: 'load' });
  const co = await outcome();
  check(res.status() < 400 && !co.isError, `cancel on ${label} -> ${href}`, `${res.status()} ${co.heading}`);
}

/* ═════════════════════════════════════════ cancel from edit forms ═══ */
// Deferred until after the fixtures exist; see the end of the run.

/* ══════════════════════════════════════════════════ blog post ═══ */
section('Blog: create with a cover image');
await go('/members/blog/new');
await page.type('#title', 'Audit Post With Cover');
await writeRich('A paragraph written in the editor for the audit run.');
await (await page.$('#cover')).uploadFile(IMG_A);
await new Promise((r) => setTimeout(r, 400));
check(
  await page.evaluate(() => {
    const img = document.querySelector('#cover-preview img');
    return !!img && img.complete && img.naturalWidth > 0;
  }),
  'the chosen cover previews before saving'
);
await page.type('#cover_alt', 'A plain blue test image');
await page.select('#status', 'published');
await submitForm();
let o = await outcome();
check(!o.isError && /^\/members\/blog\/[a-z0-9-]+$/.test(o.url), 'blog post saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
check(o.fieldErrors.length === 0, 'no validation errors on the post', o.fieldErrors.join('; '));

const postUrl = o.url;
let broken = await brokenImages();
check(broken.length === 0, 'cover image renders on the post', broken.join(', '));
check(
  await page.evaluate(() => !!document.querySelector('.prose')?.textContent.trim()),
  'post body rendered'
);

section('Blog: edit, then cancel out of an edit');
await go(`${postUrl}/edit`);
o = await outcome();
check(o.heading?.startsWith('Edit'), 'edit form opens', o.heading || '');
check(
  await page.evaluate(() => {
    const ed = document.querySelector('trix-editor');
    return !!ed && ed.editor.getDocument().toString().trim().length > 0;
  }),
  'editor is pre-filled with the existing post'
);
await writeRich(' Added during the audit edit.');
await submitForm();
o = await outcome();
check(!o.isError && /^\/members\/blog\/[a-z0-9-]+$/.test(o.url), 'edit saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
broken = await brokenImages();
check(broken.length === 0, 'cover survives an edit', broken.join(', '));

/* ══════════════════════════════════════════════════ tool locker ═══ */
section('Tool Locker: create with photos');
await go('/members/locker/new');
await page.type('#name', 'Audit Torque Wrench');
await writeRich('Calibrated last month. Please do not use it as a breaker bar.');
await page.type('#location_label', 'Hangar 3');
await (await page.$('#photos')).uploadFile(IMG_A, IMG_B);
await page.type('#photo_alt', 'Blue test image');
await submitForm();
o = await outcome();
check(!o.isError && /^\/members\/locker\/\d+$/.test(o.url), 'tool saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
const toolUrl = o.url;
broken = await brokenImages();
check(broken.length === 0, 'tool photos render', broken.join(', '));
check(
  await page.evaluate(() => document.querySelectorAll('.carousel-slide').length >= 2),
  'both photos are in the carousel'
);

section('Tool Locker: edit and remove a photo');
await go(`${toolUrl}/edit`);
await page.type('#brand', ' Snap-on');
await submitForm();
o = await outcome();
check(!o.isError && o.url === toolUrl, 'tool edit saved', `${o.url} ${o.heading}`);

/* ══════════════════════════════════════════════════ builds ═══ */
section('Builds: create a project with a cover');
await go('/members/builds/new');
await page.type('#title', 'Audit Build Project');
await page.type('#aircraft_type', 'Vans RV-9A');
await writeRich('The project write-up, typed into the editor.');
await (await page.$('#cover')).uploadFile(IMG_B);
await page.type('#cover_alt', 'Orange test image');
await submitForm();
o = await outcome();
check(!o.isError && o.url.includes('/updates/new'), 'build saved and went to the first log entry', `${o.url} ${o.heading}`);
const buildEntryUrl = o.url;

section('Builds: post a log entry with photos');
await page.type('#title', 'Audit Log Entry');
await writeRich('What happened during the audit run.');
await (await page.$('#photos')).uploadFile(IMG_A, IMG_B);
await submitForm();
o = await outcome();
check(!o.isError && o.url.startsWith('/builds/'), 'log entry saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
const buildUrl = o.url;
broken = await brokenImages();
check(broken.length === 0, 'build cover and log photos render', broken.join(', '));

section('Builds: edit the project and the entry');
const buildId = await page.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find((x) => /\/members\/builds\/\d+\/edit/.test(x.getAttribute('href') || ''));
  return a ? a.getAttribute('href').match(/builds\/(\d+)/)[1] : null;
});
if (buildId) {
  await go(`/members/builds/${buildId}/edit`);
  await page.select('#status', 'painting');
  await submitForm();
  o = await outcome();
  check(!o.isError && o.url.startsWith('/builds/'), 'build edit saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
} else {
  check(false, 'found the build edit link');
}

/* ══════════════════════════════════════════════════ events ═══ */
section('Events: create with a poster and photos');
await go('/members/admin/events/new');
await page.type('#title', 'Audit Fly-In Breakfast');
await page.type('#summary', 'An event created by the audit run.');
await writeRich('Details of the audit event.');
await page.evaluate(() => {
  document.querySelector('#starts_at').value = '2026-10-10T09:00';
  document.querySelector('#ends_at').value = '2026-10-10T12:00';
});
await (await page.$('#poster')).uploadFile(IMG_A);
await (await page.$('#photos')).uploadFile(IMG_B);
await submitForm();
o = await outcome();
check(!o.isError && o.url === '/members/admin/events', 'event saved', `${o.url} ${o.heading} ${o.fieldErrors.join(';')}`);
check(o.flash !== null, 'a confirmation was shown', o.flash || '(none)');

await go('/events/audit-fly-in-breakfast-2026');
broken = await brokenImages();
check(broken.length === 0, 'event poster and photos render', broken.join(', '));

/* ══════════════════════════════════════════════════ account ═══ */
section('Account: profile and avatar');
await go('/members/account');
await page.type('#display_name', 'Audit Runner');
await submitForm('form[action$="/members/account"]');
o = await outcome();
check(o.flash?.includes('saved'), 'profile saved', o.flash || '(no flash)');

await go('/members/account');
await (await page.$('#avatar')).uploadFile(IMG_B);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }),
  page.click('form[action$="/account/avatar"] button[type=submit]'),
]);
o = await outcome();
check(o.flash?.includes('Photo'), 'avatar uploaded', o.flash || '(no flash)');
broken = await brokenImages();
check(broken.length === 0, 'avatar renders', broken.join(', '));

/* ══════════════════════════════════════════════ validation paths ═══ */
section('Validation: an invalid form comes back with errors, not a crash');
await go('/members/locker/new');
await page.type('#name', 'x'); // too short
await submitForm();
o = await outcome();
check(o.fieldErrors.length > 0, 'invalid tool shows a field error', o.bodyStart);
check(
  await page.evaluate(() => !!document.querySelector('trix-editor') || !!document.querySelector('[data-rich-source]')),
  'the re-rendered form still has its editor'
);

/* ═══════════════════════════════════════ cancel out of an edit form ═══ */
section('Cancel from an edit form');
const EDIT_CANCELS = [
  [`${postUrl}/edit`, 'blog post'],
  [`${toolUrl}/edit`, 'tool'],
  [buildId ? `/members/builds/${buildId}/edit` : null, 'build'],
];
for (const [from, label] of EDIT_CANCELS) {
  if (!from) continue;
  await go(from);
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === 'Cancel');
    return a ? a.getAttribute('href') : null;
  });
  if (!href) {
    check(false, `cancel on ${label} edit`, 'no Cancel link');
    continue;
  }
  resetErrors();
  const res = await page.goto(new URL(href, `${BASE}/`).href, { waitUntil: 'load' });
  const co = await outcome();
  check(res.status() < 400 && !co.isError, `cancel on ${label} edit -> ${href}`, `${res.status()} ${co.heading}`);
}

/* ══════════════════════════════════════════════════ clean up ═══ */
section('Delete what the audit created');
const DELETIONS = [
  [`${postUrl}/edit`, 'form[action$="/delete"]', 'blog post'],
  [`${toolUrl}/edit`, 'form[action$="/delete"]', 'tool'],
];
for (const [url, selector, label] of DELETIONS) {
  await go(url);
  page.once('dialog', (d) => d.accept());
  const form = await page.$(selector);
  if (!form) {
    check(false, `delete ${label}`, 'no delete form found');
    continue;
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.click(`${selector} button[type=submit]`),
  ]);
  o = await outcome();
  check(o.flash !== null, `deleted the ${label}`, o.flash || '(no flash)');
}

if (buildId) {
  await go(`/members/builds/${buildId}/edit`);
  page.once('dialog', (d) => d.accept());
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.click('form.danger-zone button[type=submit]'),
  ]);
  check((await outcome()).flash !== null, 'deleted the build');
}

await browser.close();
fs.rmSync(TMP, { recursive: true, force: true });

// Leave no fake administrator behind in the directory.
check(removeAuditAdmin(), 'removed the audit test account');

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`);
}
process.exit(failures.length ? 1 : 0);
