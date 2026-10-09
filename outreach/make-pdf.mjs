/**
 * Renders outreach/brochure.html to a print-ready PDF.
 *
 *   node outreach/make-pdf.mjs
 *
 * Requires a Chrome/Chromium binary; point CHROME_PATH at one if the default
 * is wrong. Screenshots come from outreach/shots (see capture.mjs).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(process.env.PUPPETEER_ROOT || '/tmp/pptr/');
const puppeteer = require('puppeteer-core');

const EXEC =
  process.env.CHROME_PATH ||
  '/tmp/pptr/.cache/chrome-headless-shell/linux-152.0.7977.42/chrome-headless-shell-linux64/chrome-headless-shell';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'brochure.html');
const output = path.join(here, 'EAA-1699-website-walkthrough.pdf');

const browser = await puppeteer.launch({
  executablePath: EXEC,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
});

const page = await browser.newPage();
await page.goto(pathToFileURL(source).href, { waitUntil: 'networkidle0' });

// Report anything that failed to load rather than shipping a PDF with holes.
const missing = await page.evaluate(() =>
  Array.from(document.images)
    .filter((img) => !img.complete || img.naturalWidth === 0)
    .map((img) => img.getAttribute('src'))
);
if (missing.length) {
  console.error('Images failed to load:', missing);
  await browser.close();
  process.exit(1);
}

await page.pdf({
  path: output,
  width: '8.5in',
  height: '11in',
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

await browser.close();
console.log(`PDF written to ${output}`);
