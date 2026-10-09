/**
 * Captures the screenshots used in the outreach brochure.
 *
 * Runs against a local dev server with the demo content seeded. Shots are
 * taken at 2x device scale so they stay crisp at print resolution.
 *
 *   node outreach/capture.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.env.PUPPETEER_ROOT || '/tmp/pptr/');
const puppeteer = require('puppeteer-core');

const EXEC =
  process.env.CHROME_PATH ||
  '/tmp/pptr/.cache/chrome-headless-shell/linux-152.0.7977.42/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const EMAIL = process.env.SEED_ADMIN_EMAIL || 'gary.jones@hawthorncs.com';
const PASSWORD = process.env.SMOKE_PASSWORD || 'correct-horse-battery-hangar-42';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(outDir, { recursive: true });

/**
 * [name, path, needsLogin, viewportHeight, scrollY]
 *
 * Heights match the aspect ratio each shot is placed at in the brochure, so
 * nothing has to be cropped away afterwards. The site header is sticky, so
 * scrolling still leaves the navigation in frame -- which is what makes these
 * read as "a page", rather than as a band of dark blue page heading.
 */
const SHOTS = [
  // Wide banner placements (about 2.4:1)
  ['home', '/', false, 900, 0],
  ['events', '/events', false, 602, 380],
  ['event-detail', '/events/fall-fly-in-breakfast-2026', false, 602, 300],
  ['past-events', '/events/past', false, 602, 400],
  ['builds', '/builds', false, 602, 470],
  ['build-log', '/builds/martas-rv-7a', false, 602, 980],
  ['tool-locker', '/members/locker', true, 520, 300],

  // Half-width placements (about 1.4:1)
  ['join', '/join', false, 1036, 300],
  ['tool-detail', '/members/locker/1', true, 1036, 190],
  ['borrow-requests', '/members/locker/requests', true, 1036, 130],
  ['admin-applications', '/members/admin/applications', true, 1036, 190],
  ['members-dashboard', '/members', true, 867, 120],
  ['blog', '/members/blog', true, 867, 230],

  // Captured for reference; not all are placed in the brochure.
  ['build-detail', '/builds/martas-rv-7a', false, 900, 0],
  ['contact', '/contact', false, 900, 260],
  ['login', '/login', false, 820, 0],
  ['blog-post', '/members/blog/what-a-technical-counselor-visit-actually-looks-like', true, 900, 200],
  ['admin-people', '/members/admin/members', true, 1000, 250],
  ['admin-events', '/members/admin/events', true, 900, 200],
];

const browser = await puppeteer.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

// Sign in once; the session carries through the members-only shots.
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
await page.type('#email', EMAIL);
await page.type('#password', PASSWORD);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle0' }),
  page.click('button[type="submit"]'),
]);
const signedIn = page.url().includes('/members');
console.log(signedIn ? 'signed in' : `WARNING: not signed in (${page.url()})`);

const cookies = await browser.cookies();

for (const [name, urlPath, needsLogin, height, scrollY] of SHOTS) {
  if (!needsLogin) {
    // Public pages are captured signed out, so the brochure shows what a
    // visitor actually sees.
    await browser.deleteCookie(...cookies);
  }

  // Load at a tall viewport first so lazy-loaded images below the fold have
  // been requested, then resize to the framing height before shooting.
  await page.setViewport({ width: 1440, height: Math.max(height, 1400), deviceScaleFactor: 2 });
  await page.goto(`${BASE}${urlPath}`, { waitUntil: 'networkidle0', timeout: 30000 });

  await page.setViewport({ width: 1440, height, deviceScaleFactor: 2 });
  await page.evaluate((y) => window.scrollTo(0, y), scrollY || 0);
  await new Promise((r) => setTimeout(r, 450));

  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  ${name.padEnd(22)} ${urlPath}${scrollY ? `  (scrolled ${scrollY}px)` : ''}`);

  if (!needsLogin) {
    await browser.setCookie(...cookies);
  }
}

await browser.close();
console.log(`\n${SHOTS.length} screenshots written to ${outDir}`);
