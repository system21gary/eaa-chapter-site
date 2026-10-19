/**
 * End-to-end smoke test.
 *
 * Drives the site the way a browser would -- cookies, CSRF tokens, redirects --
 * through the real password-reset flow, then walks every members-only page.
 * Run against a *development* server:  node scripts/smoke.mjs
 */
import * as Users from '../src/models/users.js';
import { all, get, run } from '../src/db/index.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { documentPath } from '../src/lib/document-files.js';
import * as Scheduler from '../src/lib/scheduler.js';
import * as Notices from '../src/lib/notices.js';
import * as Minutes from '../src/lib/minutes.js';
import { todosFor } from '../src/lib/todos.js';
import * as Mail from '../src/lib/mailer.js';
import { eventReminderEmail, meetingNoticeEmail, eventUpdateEmail, inlineAttachments } from '../src/lib/mailer.js';
import nodemailer from 'nodemailer';
import { makeToken } from '../src/lib/unsubscribe.js';
import { zonedToUtc } from '../src/lib/localtime.js';
import config from '../src/config.js';
import { parseLocal, toLocalInput, toLocalDateInput } from '../src/lib/localtime.js';

/**
 * This suite submits the contact form, requests an account, and triggers a
 * password reset -- all of which generate real mail once a transport is live.
 * Run against a server configured for SMTP and it emails actual people,
 * including whoever CONTACT_EMAIL points at, every time.
 *
 * So: refuse by default, and make saying otherwise deliberate.
 *
 * This reads the .env this script shares with the server, which is how the pair
 * is actually run. It cannot see the configuration of a *remote* server -- so
 * this is a seatbelt against the common mistake, not a guarantee. Delivery is
 * the server's job, and only restarting the server with MAIL_TRANSPORT=outbox
 * genuinely stops it; overriding the variable here only silences this check.
 */
if (config.mail.transport === 'smtp' && !process.argv.includes('--allow-live-mail')) {
  console.error(
    '\nRefusing to run: MAIL_TRANSPORT=smtp in .env, so this suite would send real\n' +
      'email to real addresses (a password reset to the admin, form notifications\n' +
      'to CONTACT_EMAIL) on every run.\n\n' +
      'To test without sending, restart the *server* with mail off:\n\n' +
      '  MAIL_TRANSPORT=outbox node server.js\n\n' +
      'Or pass --allow-live-mail if you do want the mail to go out.\n'
  );
  process.exit(1);
}

const BASE = process.env.BASE_URL || 'http://localhost:3000';
/**
 * The suite's own administrator, not the chapter's.
 *
 * This used to sign in as the real admin, which meant every run reset that
 * person's password and -- because issuing a reset token invalidates any
 * outstanding one -- silently killed a reset link they might be part-way
 * through using. Running the tests should not be able to lock an officer out of
 * their own site.
 *
 * The address is on a reserved documentation domain, so mail to it is never
 * attempted. The account is created on demand and removed again in Cleanup.
 */
const EMAIL = process.env.SMOKE_EMAIL || 'smoke.test.admin@example.com';
const PASSWORD = 'correct-horse-battery-hangar-42';

function ensureTestAdmin() {
  // A membership application for this address should be impossible -- the /join
  // route drops requests from people who already have accounts. But an
  // interrupted run can leave one behind, and because at most one application
  // per address may be open, that stale row then makes a later run's check look
  // like a failure in the route rather than leftover state. Clear it first.
  run('DELETE FROM membership_applications WHERE email = ?', [EMAIL]);

  let user = Users.findByEmail(EMAIL);
  if (!user) {
    Users.createUser({
      email: EMAIL,
      firstName: 'Smoke',
      lastName: 'Test',
      role: 'admin',
      status: 'active',
    });
    user = Users.findByEmail(EMAIL);
  } else if (user.role !== 'admin' || user.status !== 'active') {
    // Left over from an interrupted run in a state that cannot sign in.
    Users.setRole(user.id, 'admin');
    run("UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    user = Users.findByEmail(EMAIL);
  }
  return user;
}

let cookie = '';
let pass = 0;
let fail = 0;

function record(ok, label, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label} ${extra}`);
  }
}

async function req(path, { method = 'GET', body = null, expect = null, redirect = 'manual', origin = null } = {}) {
  const headers = { cookie };
  let payload;
  if (body) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(body).toString();
    headers.origin = origin ?? BASE;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect });

  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const pair = c.split(';')[0];
    if (pair.startsWith('eaa1699.sid=')) cookie = pair;
  }

  const text = res.headers.get('content-type')?.includes('text') ? await res.text() : '';
  if (expect != null) {
    record(res.status === expect, `${method} ${path}`, `→ ${res.status}, wanted ${expect}`);
  }
  return { res, text, status: res.status };
}

/** Submits a real multipart/form-data POST, the way a browser does with a file input. */
async function multipart(path, fields, { origin = null } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v && v.blob) form.append(k, v.blob, v.name);
    else form.append(k, v);
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { cookie, origin: origin ?? BASE },
    body: form,
    redirect: 'manual',
  });
  const text = res.headers.get('content-type')?.includes('text') ? await res.text() : '';
  return { res, text, status: res.status };
}

function csrfFrom(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}

console.log(`\nSmoke test against ${BASE}\n`);

/*
 * Up front, because several checks below depend on EMAIL being an address the
 * site already knows: that /forgot queues a message for it, and that asking to
 * join with it is silently suppressed.
 */
const admin = ensureTestAdmin();

/* ---------------------------------------------------------------- public */
console.log('Public pages');
for (const p of ['/', '/about', '/events', '/events/past', '/builds', '/contact', '/login', '/forgot', '/healthz', '/robots.txt', '/sitemap.xml', '/events/calendar.ics']) {
  await req(p, { expect: 200 });
}

// Detail pages, discovered from the index rather than hard-coded.
const { text: buildsHtml } = await req('/builds');
const buildSlugs = [...buildsHtml.matchAll(/href="[^"]*\/builds\/([a-z0-9-]+)"/g)].map((m) => m[1]);
const uniqueBuilds = [...new Set(buildSlugs)].slice(0, 4);
console.log(`\nBuild detail pages (${uniqueBuilds.length} found)`);
for (const slug of uniqueBuilds) await req(`/builds/${slug}`, { expect: 200 });

const { text: eventsHtml } = await req('/events');
const eventSlugs = [...new Set([...eventsHtml.matchAll(/href="[^"]*\/events\/([a-z0-9-]+)"/g)].map((m) => m[1]))]
  .filter((s) => s !== 'past')
  .slice(0, 4);
console.log(`\nEvent detail pages (${eventSlugs.length} found)`);
for (const slug of eventSlugs) await req(`/events/${slug}`, { expect: 200 });

/* --------------------------------------------------------- gated access */
console.log('\nAccess control (signed out)');
for (const p of ['/members', '/members/blog', '/members/locker', '/members/builds', '/members/directory', '/members/admin/members', '/members/admin/log']) {
  const { status } = await req(p);
  record(status === 302, `${p} redirects to login`, `→ ${status}`);
}

/* --------------------------------------------------------------- CSRF */
/* ------------------------------------------------------------ base path */
// Whether the site sits at a domain root or under a BASE_PATH prefix, every
// generated URL must carry that prefix -- otherwise the browser resolves
// assets against the domain root and the page arrives unstyled.
console.log('\nURL prefixing');
{
  const { text } = await req('/');
  // The app's own reading of BASE_PATH (trimmed, normalised), not a copy of it.
  const prefix = config.basePath;
  const cssHref = text.match(/href="([^"]*\/assets\/css\/site\.css[^"]*)"/)?.[1];
  record(Boolean(cssHref), 'the stylesheet is linked');
  if (cssHref) {
    record(
      cssHref.startsWith(`${prefix}/assets/`),
      `asset URLs carry the base path (${prefix || 'none'})`,
      `-> ${cssHref}`
    );
    const css = await req(prefix ? cssHref.slice(prefix.length) : cssHref);
    record(css.status === 200, 'the stylesheet actually loads', `-> ${css.status}`);
  }
  const navHref = text.match(/href="([^"]*)"[^>]*>\s*Upcoming Events/)?.[1];
  record(
    Boolean(navHref) && navHref.startsWith(`${prefix}/events`),
    'nav links carry the base path',
    `-> ${navHref}`
  );

  // Every internal href and form action on every page, checked in one sweep.
  // A form whose action is missing the prefix posts to nowhere, which looks
  // to a member like "saving is broken" -- and only under a prefix, so it is
  // easy to miss.
  const pages = ['/', '/events', '/builds', '/contact', '/join', '/login'];
  const unprefixed = [];
  for (const p of pages) {
    const html = (await req(p)).text;
    for (const m of html.matchAll(/(?:href|action)="(\/[^"]*)"/g)) {
      const url = m[1];
      if (url.startsWith('//')) continue;
      if (prefix && !url.startsWith(`${prefix}/`) && url !== prefix) unprefixed.push(`${p}: ${url}`);
    }
  }
  record(
    unprefixed.length === 0,
    'no internal link or form action is missing the base path',
    unprefixed.slice(0, 4).join(', ')
  );
}

console.log('\nCSRF');
{
  const { status, text } = await req('/contact', { method: 'POST', body: { name: 'Mallory', email: 'm@example.com', message: 'no token here at all' } });
  record(status === 403, 'POST without a CSRF token is rejected', `→ ${status}`);
  // The rejection happens before the auth middleware runs, so this also proves
  // the error page can render that early in the pipeline.
  record(text.includes('Not for you, sorry'), 'the 403 page renders properly');
}
{
  const { text } = await req('/contact');
  const token = csrfFrom(text);
  const { status } = await req('/contact', {
    method: 'POST',
    body: { _csrf: token, name: 'Priya Tester', email: 'priya@example.com', topic: 'General question', message: 'This is a genuine test message from the smoke suite.', rendered_at: String(Date.now() - 9000) },
  });
  record(status === 302, 'POST with a valid CSRF token succeeds', `→ ${status}`);
}
{
  // The origin check accepts declared public origins so the site works behind
  // a reverse proxy. An undeclared origin must still be refused, even with a
  // valid CSRF token -- otherwise that allowance has quietly disabled it.
  const { text } = await req('/contact');
  const { status } = await req('/contact', {
    method: 'POST',
    origin: 'https://evil.example.com',
    body: { _csrf: csrfFrom(text), name: 'Mallory', email: 'm@example.com', topic: 'General question', message: 'Submitted from an origin the site has never heard of.', rendered_at: String(Date.now() - 9000) },
  });
  record(status === 403, 'POST from an undeclared origin is refused', `→ ${status}`);
}

/* ------------------------------------------------------------- mail queue */
console.log('\nOutbound mail is queued, not sent in-request');
{
  // The contact form above generated a notification. It must exist as a queued
  // row, which is what proves the route handed delivery to the background
  // worker instead of waiting on a relay.
  //
  // This matters beyond tidiness. Sending inside the request makes a relay
  // outage look like a broken form, and on /forgot it turns the deliberately
  // identical responses into an account-enumeration oracle: only a registered
  // address attempts delivery, so only a registered address can fail.
  const queued = get(
    `SELECT id, sent_at, error FROM email_outbox
      WHERE subject LIKE '%Priya Tester%' ORDER BY id DESC LIMIT 1`
  );
  record(!!queued, 'the contact notification reached the outbox');

  const before = get('SELECT COUNT(*) AS n FROM email_outbox').n;
  const { text } = await req('/forgot');
  const reset = await req('/forgot', {
    method: 'POST',
    body: { _csrf: csrfFrom(text), email: EMAIL },
  });
  const after = get('SELECT COUNT(*) AS n FROM email_outbox').n;
  record(reset.status === 302, 'a reset request for a known address succeeds', `→ ${reset.status}`);
  record(after === before + 1, 'it queued exactly one message', `${before} → ${after}`);

  // Same request for an address with no account: same answer, no mail.
  const { text: t2 } = await req('/forgot');
  const unknown = await req('/forgot', {
    method: 'POST',
    body: { _csrf: csrfFrom(t2), email: `nobody.${Date.now()}@example.com` },
  });
  const after2 = get('SELECT COUNT(*) AS n FROM email_outbox').n;
  record(
    unknown.status === reset.status &&
      unknown.res.headers.get('location') === reset.res.headers.get('location'),
    'an unknown address gets an identical response',
    `${unknown.status} vs ${reset.status}`
  );
  record(after2 === after, 'and generates no mail', `${after} → ${after2}`);
}

/* ------------------------------------------------- membership requests */
console.log('\nMembership requests');
const APPLICANT = `smoke.applicant.${Math.floor(process.uptime() * 1000)}@example.com`;
{
  const { text, status } = await req('/join');
  record(status === 200 && text.includes('Request an account'), 'request form renders', `→ ${status}`);

  const sent = await req('/join', {
    method: 'POST',
    body: {
      _csrf: csrfFrom(text),
      first_name: 'Smoke',
      last_name: 'Applicant',
      email: APPLICANT,
      message: 'Submitted automatically by the smoke test suite. Safe to decline.',
      rendered_at: String(Date.now() - 9000),
    },
  });
  record(sent.status === 302, 'request accepted', `→ ${sent.status}`);

  // A second request for the same address must look identical from outside,
  // so the form cannot be used to discover who has already applied.
  const again = await req('/join');
  const dupe = await req('/join', {
    method: 'POST',
    body: {
      _csrf: csrfFrom(again.text),
      first_name: 'Smoke',
      last_name: 'Applicant',
      email: APPLICANT,
      message: 'Same address again — the response must be indistinguishable.',
      rendered_at: String(Date.now() - 9000),
    },
  });
  record(dupe.status === 302, 'duplicate request answered identically', `→ ${dupe.status}`);

  // An address that already has an account must also be indistinguishable.
  const known = await req('/join');
  const existing = await req('/join', {
    method: 'POST',
    body: {
      _csrf: csrfFrom(known.text),
      first_name: 'Gary',
      last_name: 'Jones',
      email: EMAIL,
      message: 'An address that already belongs to a member — must not leak that.',
      rendered_at: String(Date.now() - 9000),
    },
  });
  record(existing.status === 302, 'existing-member address answered identically', `→ ${existing.status}`);

  const short = await req('/join');
  const invalid = await req('/join', {
    method: 'POST',
    body: { _csrf: csrfFrom(short.text), first_name: 'X', last_name: 'Y', email: 'nope', message: 'too short', rendered_at: String(Date.now() - 9000) },
  });
  record(invalid.status === 400, 'invalid request rejected', `→ ${invalid.status}`);
}

/* ------------------------------------------------------- password reset */
console.log('\nPassword reset → login');
const rawToken = Users.createPasswordResetToken(admin.id);

{
  const { text, status } = await req(`/reset/${rawToken}`);
  record(status === 200 && text.includes('Choose a new password'), 'reset form renders for a valid token', `→ ${status}`);
  const token = csrfFrom(text);

  // A weak password must be rejected without consuming the reset token.
  const weak = await req(`/reset/${rawToken}`, { method: 'POST', body: { _csrf: token, password: 'password123', confirm: 'password123' } });
  record(weak.status === 400, 'weak password rejected', `→ ${weak.status}`);

  const retry = await req(`/reset/${rawToken}`);
  record(retry.status === 200, 'token still valid after a rejected attempt', `→ ${retry.status}`);

  const good = await req(`/reset/${rawToken}`, { method: 'POST', body: { _csrf: csrfFrom(retry.text), password: PASSWORD, confirm: PASSWORD } });
  record(good.status === 200 && good.text.includes('Password updated'), 'strong password accepted', `→ ${good.status}`);

  const reuse = await req(`/reset/${rawToken}`);
  record(reuse.status === 400, 'token cannot be reused', `→ ${reuse.status}`);
}

{
  const { text } = await req('/login');
  const token = csrfFrom(text);
  const bad = await req('/login', { method: 'POST', body: { _csrf: token, email: EMAIL, password: 'not-the-password-at-all' } });
  record(bad.status === 401, 'wrong password rejected', `→ ${bad.status}`);

  const fresh = await req('/login');
  const ok = await req('/login', { method: 'POST', body: { _csrf: csrfFrom(fresh.text), email: EMAIL, password: PASSWORD } });
  record(ok.status === 302, 'correct password signs in', `→ ${ok.status}`);
}

/* -------------------------------------------------------- members area */
console.log('\nMembers area (signed in as admin)');
for (const p of ['/members', '/members/blog', '/members/locker', '/members/locker/new', '/members/locker/requests', '/members/builds', '/members/builds/new', '/members/directory', '/members/account', '/members/admin/events', '/members/admin/events/new', '/members/admin/members', '/members/admin/messages', '/members/admin/stats', '/members/admin/log']) {
  await req(p, { expect: 200 });
}

// Member-only build should now be visible.
{
  const { text } = await req('/builds');
  record(text.includes('Members only'), 'members-only build visible once signed in');
}

// Tool + blog detail pages.
{
  const { text } = await req('/members/locker');
  const ids = [...new Set([...text.matchAll(/href="[^"]*\/members\/locker\/(\d+)"/g)].map((m) => m[1]))].slice(0, 3);
  console.log(`\nTool detail pages (${ids.length})`);
  for (const id of ids) await req(`/members/locker/${id}`, { expect: 200 });
}
{
  const { text } = await req('/members/blog');
  const slugs = [...new Set([...text.matchAll(/href="[^"]*\/members\/blog\/([a-z0-9-]+)"/g)].map((m) => m[1]))]
    .filter((s) => s !== 'new')
    .slice(0, 3);
  console.log(`\nBlog post pages (${slugs.length})`);
  for (const slug of slugs) await req(`/members/blog/${slug}`, { expect: 200 });
}

/* -------------------------------------------------------------- media */
console.log('\nMedia route');
{
  const { text } = await req('/builds');
  const m = text.match(/src="[^"]*(\/media\/builds\/[^"]+\.webp)"/);
  if (m) {
    const { res } = await req(m[1]);
    record(res.status === 200 && res.headers.get('content-type') === 'image/webp', 'public build image served as image/webp');
  } else {
    record(false, 'found a build image to fetch');
  }
  const traversal = await req('/media/../../server.js');
  record(traversal.status === 404 || traversal.status === 400, 'path traversal blocked', `→ ${traversal.status}`);
  const nonWebp = await req('/media/tools/evil.html');
  record(nonWebp.status === 404, 'non-webp paths refused', `→ ${nonWebp.status}`);
}

/* --------------------------------------------------------------- write */
console.log('\nWrite operations');
{
  const { text } = await req('/members/builds/new');
  const token = csrfFrom(text);
  const created = await req('/members/builds/new', {
    method: 'POST',
    body: {
      _csrf: token,
      title: 'Smoke Test Project',
      aircraft_type: 'Piper J-3 Cub',
      build_kind: 'restoration',
      status: 'building',
      percent_complete: '15',
      visibility: 'public',
      summary: 'Created by the smoke test suite.',
      body_md: 'A test project created automatically. Safe to delete.',
    },
  });
  record(created.status === 302, 'create a build log', `→ ${created.status}`);

  const list = await req('/members/builds');
  record(list.text.includes('Smoke Test Project'), 'new build appears in the members list');
}
{
  const { text } = await req('/members/locker/new');
  const created = await req('/members/locker/new', {
    method: 'POST',
    body: {
      _csrf: csrfFrom(text),
      name: 'Smoke Test Wrench',
      condition: 'good',
      availability: 'available',
      description: 'Created by the smoke test suite.',
      location_label: 'Nowhere in particular',
    },
  });
  record(created.status === 302, 'create a tool listing', `→ ${created.status}`);
}

/* ------------------------------------------- uploads, CSRF and rich text */
console.log('\nUpload forms and rich text');
{
  // Upload forms submit as multipart/form-data, which express.urlencoded does
  // not parse -- so the CSRF token is only readable after multer has run. If
  // that check is not wired in after multer, every upload form breaks (or,
  // worse, goes unchecked).
  const { text } = await req('/members/locker/new');
  const token = csrfFrom(text);

  const noToken = await multipart('/members/locker/new', {
    name: 'Smoke Multipart No Token',
    condition: 'good',
    availability: 'available',
  });
  record(noToken.status === 403, 'multipart POST without a CSRF token is refused', `→ ${noToken.status}`);

  const withToken = await multipart('/members/locker/new', {
    _csrf: token,
    name: 'Smoke Multipart Tool',
    condition: 'good',
    availability: 'available',
    description: '<p>Bench notes</p>',
    description_format: 'html',
  });
  record(withToken.status === 302, 'multipart POST with a valid token succeeds', `→ ${withToken.status}`);

  // The rich editor posts HTML. It is sanitised before conversion, so script
  // and event handlers can never reach the stored markdown.
  const fresh = await req('/members/locker/new');
  const evil = await multipart('/members/locker/new', {
    _csrf: csrfFrom(fresh.text),
    name: 'Smoke Rich Text Tool',
    condition: 'good',
    availability: 'available',
    description:
      '<p><strong>Bold</strong> and <em>italic</em></p>' +
      '<script>alert(1)</script>' +
      '<img src=x onerror=alert(2)>' +
      '<a href="javascript:alert(3)">bad link</a>' +
      '<ul><li>a list item</li></ul>',
    description_format: 'html',
  });
  record(evil.status === 302, 'rich-text submission accepted', `→ ${evil.status}`);

  const listing = await req('/members/locker?q=Smoke%20Rich%20Text%20Tool');
  const id = listing.text.match(/href="[^"]*\/members\/locker\/(\d+)"/)?.[1];
  if (id) {
    const page = await req(`/members/locker/${id}`);
    // Look for the injected payload specifically -- the page legitimately
    // contains <script src> tags for the site's own JavaScript.
    record(!page.text.includes('alert(1)'), 'the injected <script> body never reaches the page');
    record(!/<script>\s*alert/i.test(page.text), 'no inline <script> survives');
    record(!page.text.includes('alert(2)') && !/onerror\s*=/i.test(page.text), 'no event-handler attribute survives');
    record(!page.text.includes('javascript:'), 'no javascript: URL survives');
    record(/<strong>Bold<\/strong>/.test(page.text), 'formatting the member asked for is kept');
    record(/<li>a list item<\/li>/.test(page.text), 'lists survive the HTML-to-markdown round trip');

    // Clean up both tools this section created.
    for (const name of ['Smoke Rich Text Tool', 'Smoke Multipart Tool']) {
      const found = await req(`/members/locker?q=${encodeURIComponent(name)}`);
      const toolId = found.text.match(/href="[^"]*\/members\/locker\/(\d+)"/)?.[1];
      if (!toolId) continue;
      const form = await req(`/members/locker/${toolId}/edit`);
      await req(`/members/locker/${toolId}/delete`, { method: 'POST', body: { _csrf: csrfFrom(form.text) } });
    }
  } else {
    record(false, 'found the rich-text tool to inspect');
  }
}

/* ------------------------------------------- application review (admin) */
console.log('\nApplication review');
{
  const { text, status } = await req('/members/admin/applications');
  record(status === 200, 'GET /members/admin/applications', `→ ${status}`);
  record(text.includes(APPLICANT), 'the smoke applicant is in the queue');
  // The earlier request submitted against the admin's own address must have
  // been dropped, not queued, so the form cannot be used to spam the queue.
  record(!text.includes(EMAIL), 'a request for an existing member never reaches the queue');

  const id = text.match(new RegExp(`applications/(\\d+)/decline`))?.[1];
  if (id) {
    // Decline rather than approve, so the suite never creates a real account.
    const done = await req(`/members/admin/applications/${id}/decline`, {
      method: 'POST',
      body: { _csrf: csrfFrom(text), note: 'Automated smoke test record.', notify: '' },
    });
    record(done.status === 302, 'decline a request', `→ ${done.status}`);

    const after = await req(`/members/admin/applications/${id}/decline`, {
      method: 'POST',
      body: { _csrf: csrfFrom((await req('/members/admin/applications')).text), note: '', notify: '' },
    });
    record(after.status === 302, 'a reviewed request cannot be reviewed twice', `→ ${after.status}`);
  } else {
    record(false, 'find a pending request to review');
  }
}

/* ------------------------------------------------------------- cleanup */
// The suite must leave the demo data exactly as it found it, so the records
// it just created are removed through the real delete routes.
console.log('\nMember administration');
{
  // A throwaway member, edited and then removed through the admin forms.
  const temp = Users.createUser({
    email: `smoke.temp.${Date.now()}@example.com`,
    firstName: 'Temp',
    lastName: 'Membr',
    role: 'member',
    status: 'pending',
  });
  const editPath = `/members/admin/members/${temp.id}/edit`;
  let page = await req(editPath);
  record(page.status === 200 && /Remove this member/.test(page.text), 'a member can be opened for editing', `-> ${page.status}`);

  let res = await req(editPath, {
    method: 'POST',
    body: { _csrf: csrfFrom(page.text), first_name: 'Temp', last_name: 'Member', email: temp.email, phone: '', eaa_number: '' },
  });
  record(res.status === 302 && Users.findById(temp.id)?.last_name === 'Member', 'a mistyped name can be corrected', `-> ${res.status}`);

  res = await req(editPath, {
    method: 'POST',
    body: { _csrf: csrfFrom(page.text), first_name: 'Temp', last_name: 'Member', email: EMAIL },
  });
  record(res.status === 400 && /already uses that address/.test(res.text), "another member's email is refused", `-> ${res.status}`);

  const deletePath = `/members/admin/members/${temp.id}/delete`;
  await req(deletePath, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(Boolean(Users.findById(temp.id)), 'removal needs the confirmation box');
  await req(deletePath, { method: 'POST', body: { _csrf: csrfFrom(page.text), confirm: 'remove' } });
  record(!Users.findById(temp.id), 'with it ticked, the member is removed');
  if (Users.findById(temp.id)) run('DELETE FROM users WHERE id = ?', [temp.id]);
}

console.log('\nOffices and email preferences');
{
  const mk = (tag, status = 'active') =>
    Users.createUser({ email: `smoke.office.${tag}.${Date.now()}@example.com`, firstName: 'Off', lastName: tag, role: 'member', status });
  const one = mk('one');
  const two = mk('two');
  const idle = mk('idle', 'pending');
  const heldBefore = Users.listBoard().find((u) => u.board_role === 'president');
  const page = await req('/members/admin/members');
  const token = csrfFrom(page.text);
  // Office is set on the member's edit form, along with their details.
  const setOffice = async (id, office) => {
    const m = Users.findById(id);
    const formPage = await req(`/members/admin/members/${id}/edit`);
    record(/name="office"/.test(formPage.text), `the edit form for ${m.last_name} has an Office field`);
    return req(`/members/admin/members/${id}/edit`, {
      method: 'POST',
      body: { _csrf: csrfFrom(formPage.text), first_name: m.first_name, last_name: m.last_name, email: m.email, phone: '', eaa_number: '', office },
    });
  };

  let res = await setOffice(one.id, 'president');
  record(res.status === 302 && Users.findById(one.id).board_role === 'president', 'an admin can name the president', `-> ${res.status}`);
  record(Users.canApprove(Users.findById(one.id)), 'the president can approve');
  const dir = await req('/members/directory');
  record(/pill-green">\s*President\s*</.test(dir.text), "the directory shows the president's office");

  res = await setOffice(two.id, 'president');
  record(Users.findById(two.id).board_role === 'president' && Users.findById(one.id).board_role === null, 'naming a new president releases the old one');

  await setOffice(two.id, 'treasurer');
  record(Users.findById(two.id).board_role === 'treasurer' && !Users.canApprove(Users.findById(two.id)), 'the treasurer is an officer but cannot approve');

  res = await setOffice(one.id, 'emperor');
  record(res.status === 400 && Users.findById(one.id).board_role === null, 'an unknown office is refused', `-> ${res.status}`);

  await setOffice(idle.id, 'secretary');
  record(Users.findById(idle.id).board_role === null, 'a member who is not active cannot hold an office');

  await setOffice(two.id, '');
  record(Users.findById(two.id).board_role === null, 'an office can be cleared');

  const acct = await req('/members/account');
  record(/Email from the chapter/.test(acct.text) && /name="mail_newsletter"[^>]*checked/.test(acct.text), 'account page lists email preferences, all on by default');
  res = await req('/members/account/mail', { method: 'POST', body: { _csrf: csrfFrom(acct.text), mail_newsletter: '1' } });
  const me = Users.findByEmail(EMAIL);
  record(res.status === 302 && me.mail_newsletter === 1 && me.mail_meeting_notices === 0 && me.mail_reminders === 0, 'unticked categories are switched off', `-> ${res.status}`);
  record(!Users.mailRecipients('mail_reminders').some((r) => r.email === EMAIL) && Users.mailRecipients('mail_newsletter').some((r) => r.email === EMAIL), 'opted-out members drop out of that category only');
  await req('/members/account/mail', { method: 'POST', body: { _csrf: csrfFrom(acct.text), mail_newsletter: '1', mail_meeting_notices: '1', mail_reminders: '1' } });

  for (const u of [one, two, idle]) run('DELETE FROM users WHERE id = ?', [u.id]);
  if (heldBefore) Users.setBoardRole(heldBefore.id, 'president');
}

console.log('\nChapter documents');
{
  const stamp = Date.now();
  const pdf = (body) => Buffer.from(`%PDF-1.4\n% ${body}\n%%EOF\n`);
  const upload = (name, buf, type = 'application/octet-stream') => ({ blob: new Blob([buf], { type }), name });
  const goodPdf = pdf(`minutes ${stamp}`);
  const title = `Smoke minutes ${stamp}`;
  const oldRole = admin.role;
  const oldOffice = Users.findById(admin.id).board_role;
  const vp = Users.createUser({ email: `smoke.vp.${stamp}@example.com`, firstName: 'Vee', lastName: 'Pee', role: 'member', status: 'active' });
  const heldVp = Users.listBoard().find((u) => u.board_role === 'vice_president' && u.id !== vp.id);
  const heldPres = Users.listBoard().find((u) => u.board_role === 'president');
  Users.setBoardRole(vp.id, 'vice_president');
  Users.setBoardRole(admin.id, null);

  const boardPage = () => req('/members/documents/board');
  const create = async (name, buf, extra = {}) => {
    const form = await req('/members/documents/board/new');
    return multipart('/members/documents/board', {
      _csrf: csrfFrom(form.text), kind: 'minutes', title, meeting_date: '2026-11-12', note: 'n', ...extra, file: upload(name, buf),
    });
  };

  // Being an administrator does not open the board's papers.
  let r = await boardPage();
  record(r.status === 403, 'an administrator who is not an officer cannot open the board workspace', `-> ${r.status}`);
  r = await req('/members/documents/board/new');
  record(r.status === 403, 'a non-officer cannot open the add form', `-> ${r.status}`);
  const formPage = await req('/members/documents');
  r = await multipart('/members/documents/board', { _csrf: csrfFrom(formPage.text), kind: 'minutes', title, file: upload('a.pdf', goodPdf) });
  record(r.status === 403 && !get('SELECT id FROM documents WHERE title = ?', [title]), 'a non-officer cannot add a document', `-> ${r.status}`);

  // An ordinary member cannot see the workspace at all.
  run("UPDATE users SET role = 'member' WHERE id = ?", [admin.id]);
  r = await boardPage();
  record(r.status === 403, 'an ordinary member cannot open the board workspace', `-> ${r.status}`);
  r = await req('/members/documents');
  record(r.status === 200, 'but can open the archive', `-> ${r.status}`);
  run("UPDATE users SET role = ? WHERE id = ?", [oldRole, admin.id]);

  // The secretary adds documents.
  Users.setBoardRole(admin.id, 'secretary');
  const bad = [
    ['a pdf that is not one', 'fake.pdf', Buffer.from('MZ not a pdf at all')],
    ['an old Word file', 'old.docx', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)])],
    ['a macro-enabled file', 'macro.docx', Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml vbaProject.bin')])],
    ['a script', 'run.sh', Buffer.from('#!/bin/sh\necho hi\n')],
    ['an image named as a pdf', 'pic.pdf', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
  ];
  for (const [what, name, buf] of bad) {
    r = await create(name, buf);
    record(r.status === 400 && !get('SELECT id FROM documents WHERE title = ?', [title]), `${what} is refused`, `-> ${r.status}`);
  }
  r = await create('minutes.pdf', goodPdf);
  const doc = get('SELECT * FROM documents WHERE title = ?', [title]);
  record(r.status === 302 && doc?.status === 'draft', 'a PDF is accepted as a draft', `-> ${r.status}`);
  const v1 = doc && get('SELECT * FROM document_versions WHERE document_id = ? AND number = 1', [doc.id]);
  const onDisk = v1 && documentPath(v1.stored_name);
  record(v1 && fs.existsSync(onDisk) && v1.sha256 === crypto.createHash('sha256').update(goodPdf).digest('hex') && /^[a-f0-9]{32}$/.test(v1.stored_name), 'it is stored under a random name with its SHA-256');

  // Before approval, members see nothing of it.
  r = await req(`/members/documents/${doc.id}/download`);
  record(r.status === 404, 'an unpublished document cannot be downloaded through the member route', `-> ${r.status}`);
  r = await req('/members/documents');
  record(!r.text.includes(title), 'it is not in the members archive');

  // Review: the secretary cannot approve, and nothing can change mid-review.
  const page = await req(`/members/documents/${doc.id}`);
  r = await req(`/members/documents/${doc.id}/submit`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(Docs_status(doc.id) === 'in_review', 'sending for review moves it to in review');
  record(Boolean(get('SELECT 1 AS x FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [vp.email, `%${title}%`])), 'the Vice President is emailed');
  r = await req(`/members/documents/${doc.id}/review`, { method: 'POST', body: { _csrf: csrfFrom(page.text), version: '1', decision: 'approved' } });
  record(r.status === 403 && Docs_status(doc.id) === 'in_review', 'the secretary cannot approve', `-> ${r.status}`);
  const again = await req(`/members/documents/${doc.id}`);
  await multipart(`/members/documents/${doc.id}/versions`, { _csrf: csrfFrom(again.text), file: upload('v2.pdf', pdf('v2')) });
  record(get('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?', [doc.id]).n === 1, 'no new version while a review is under way');

  // The President approves (Vice President would do equally well).
  Users.setBoardRole(admin.id, 'president');
  const rp = await req(`/members/documents/${doc.id}`);
  r = await req(`/members/documents/${doc.id}/review`, { method: 'POST', body: { _csrf: csrfFrom(rp.text), version: '1', decision: 'changes_requested' } });
  record(Docs_status(doc.id) === 'in_review', 'asking for changes needs a comment');
  r = await req(`/members/documents/${doc.id}/review`, { method: 'POST', body: { _csrf: csrfFrom(rp.text), version: '7', decision: 'approved' } });
  record(Docs_status(doc.id) === 'in_review', 'a decision on a version that is not the current one is refused');
  r = await req(`/members/documents/${doc.id}/review`, { method: 'POST', body: { _csrf: csrfFrom(rp.text), version: '1', decision: 'approved', comment: 'ok' } });
  const rev = get('SELECT * FROM document_reviews WHERE version_id = ?', [v1.id]);
  record(Docs_status(doc.id) === 'approved' && rev?.reviewer_office === 'president' && rev.decision === 'approved', 'the President approves; the review records the office');
  r = await req(`/members/documents/${doc.id}/review`, { method: 'POST', body: { _csrf: csrfFrom(rp.text), version: '1', decision: 'changes_requested', comment: 'x' } });
  record(Docs_status(doc.id) === 'approved', 'an approved document cannot be reviewed again');

  // Approved but not yet published is called out, on the document and in the list.
  const approvedPage = await req(`/members/documents/${doc.id}`);
  record(/Approved · not published/.test(approvedPage.text), 'the document page flags approved but not published');
  r = await boardPage();
  record(/Approved · not published/.test(r.text), 'so does the board list');
  record(/History/.test(approvedPage.text) && /approved version 1/.test(approvedPage.text) && /sent version 1 for review/.test(approvedPage.text), 'the history lists who sent and approved it');

  // Publishing.
  r = await req(`/members/documents/${doc.id}/publish`, { method: 'POST', body: { _csrf: csrfFrom(rp.text) } });
  record(get('SELECT visibility FROM documents WHERE id = ?', [doc.id]).visibility === 'members', 'approved documents can be published');
  const after = await req(`/members/documents/${doc.id}`);
  record(!after.text.includes('/publish') && after.text.includes('/unpublish'), 'once published, the page offers Take down and not Publish');
  record(!/not published/i.test(after.text) && /pill-green">Published</.test(after.text), 'and its status reads Published');
  Users.setBoardRole(admin.id, null);
  r = await req(`/members/documents/${doc.id}`);
  record(r.status === 200 && !r.text.includes('Versions') && !r.text.includes('SHA-256'), 'an administrator who is not an officer sees only the published page', `-> ${r.status}`);
  r = await req(`/members/documents/${doc.id}/versions/1/download`);
  record(r.status === 403, "and cannot use the board's version route", `-> ${r.status}`);
  run("UPDATE users SET role = 'member' WHERE id = ?", [admin.id]);
  r = await req('/members/documents');
  record(r.text.includes(title), 'members see it in the archive');
  r = await req(`/members/documents/${doc.id}/download`);
  const body = Buffer.from(await r.res.arrayBuffer());
  const disp = r.res.headers.get('content-disposition') ?? '';
  record(r.status === 200 && /^attachment/.test(disp) && r.res.headers.get('x-content-type-options') === 'nosniff' && body.equals(goodPdf), 'members download the exact file, as an attachment', `-> ${r.status} ${disp}`);
  r = await req(`/members/documents/${doc.id}`);
  record(r.status === 200 && r.text.includes('Download') && !r.text.includes('Versions'), 'members get a simple page for a published document', `-> ${r.status}`);
  r = await req(`/members/documents/${doc.id}/versions/1/download`);
  record(r.status === 403, "members cannot use the board's version route", `-> ${r.status}`);
  run("UPDATE users SET role = ? WHERE id = ?", [oldRole, admin.id]);

  // Revisions leave the published version alone.
  Users.setBoardRole(admin.id, 'secretary');
  const sp = await req(`/members/documents/${doc.id}`);
  await multipart(`/members/documents/${doc.id}/versions`, { _csrf: csrfFrom(sp.text), file: upload('v2.pdf', pdf(`v2 ${stamp}`)), note: 'typo' });
  const d2 = get('SELECT * FROM documents WHERE id = ?', [doc.id]);
  record(Docs_status(doc.id) === 'draft' && d2.published_version_id === v1.id, 'a revision is a new draft; the published version is unchanged');
  // Deleting versions, and the history that records it.
  const delPath = (n) => `/members/documents/${doc.id}/versions/${n}/delete`;
  const versionCount = () => get('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?', [doc.id]).n;
  const v2row = get('SELECT * FROM document_versions WHERE document_id = ? AND number = 2', [doc.id]);
  const dp = await req(`/members/documents/${doc.id}`);
  record(!dp.text.includes(delPath(1)) && dp.text.includes(delPath(2)), 'Delete is offered for the draft but not for the published version');
  r = await req(delPath(1), { method: 'POST', body: { _csrf: csrfFrom(dp.text) } });
  record(versionCount() === 2, 'the published version cannot be deleted', `-> ${r.status}`);
  r = await req(delPath(2), { method: 'POST', body: { _csrf: csrfFrom(dp.text) } });
  record(versionCount() === 1 && !fs.existsSync(documentPath(v2row.stored_name)), 'a draft version can be deleted, file and all');
  record(Docs_status(doc.id) === 'approved', 'deleting the newest version puts the document back to what the one before was');
  const hist = await req(`/members/documents/${doc.id}`);
  record(/deleted version 2/.test(hist.text) && hist.text.includes(v2row.sha256.slice(0, 16)), 'the history shows the deletion, with the file name and fingerprint');
  await multipart(`/members/documents/${doc.id}/versions`, { _csrf: csrfFrom(hist.text), file: upload('v3.pdf', pdf(`v3 ${stamp}`)) });
  record(Boolean(get('SELECT 1 AS x FROM document_versions WHERE document_id = ? AND number = 3', [doc.id])) && !get('SELECT 1 AS x FROM document_versions WHERE document_id = ? AND number = 2', [doc.id]), 'version numbers are not reused');

  Users.setBoardRole(admin.id, 'treasurer');
  const tp = await req(`/members/documents/${doc.id}`);
  r = await req(`/members/documents/${doc.id}/unpublish`, { method: 'POST', body: { _csrf: csrfFrom(tp.text) } });
  record(r.status === 403 && get('SELECT visibility FROM documents WHERE id = ?', [doc.id]).visibility === 'members', 'the treasurer cannot take a document down', `-> ${r.status}`);
  Users.setBoardRole(admin.id, 'secretary');
  r = await req(`/members/documents/${doc.id}/unpublish`, { method: 'POST', body: { _csrf: csrfFrom(tp.text) } });
  record(get('SELECT visibility FROM documents WHERE id = ?', [doc.id]).visibility === 'board', 'the secretary can take it down');
  const ap = await req(`/members/documents/${doc.id}`);
  r = await req(delPath(1), { method: 'POST', body: { _csrf: csrfFrom(ap.text) } });
  record(versionCount() === 2 && !ap.text.includes(delPath(1)), 'the secretary cannot delete an approved version');
  Users.setBoardRole(admin.id, 'president');
  const pp = await req(`/members/documents/${doc.id}`);
  r = await req(delPath(1), { method: 'POST', body: { _csrf: csrfFrom(pp.text) } });
  record(versionCount() === 1, 'the President can');
  r = await req(delPath(3), { method: 'POST', body: { _csrf: csrfFrom(pp.text) } });
  record(versionCount() === 1, 'the only remaining version cannot be deleted');

  // Clean up everything this block made.
  for (const v of all('SELECT stored_name FROM document_versions WHERE document_id = ?', [doc.id])) fs.rmSync(documentPath(v.stored_name), { force: true });
  run('DELETE FROM documents WHERE id = ?', [doc.id]);
  run('DELETE FROM email_outbox WHERE to_addr = ?', [vp.email]);
  run('DELETE FROM users WHERE id = ?', [vp.id]);
  Users.setBoardRole(admin.id, oldOffice);
  run('UPDATE users SET role = ? WHERE id = ?', [oldRole, admin.id]);
  for (const u of [heldPres, heldVp]) if (u && !Users.findById(u.id).board_role) Users.setBoardRole(u.id, u.board_role);
}

function Docs_status(id) {
  return get('SELECT status FROM documents WHERE id = ?', [id])?.status;
}

console.log('\nScheduled emails and unsubscribe');
{
  // The mailer echoes every queued message to the console in development; with a
  // whole membership per reminder that would bury the results, so hide just those.
  const realLog = console.log;
  console.log = (...args) => {
    const first = String(args[0] ?? '');
    if (first.includes('outbox #') || first.startsWith('[scheduler]')) return;
    realLog(...args);
  };
  const stamp = Date.now();
  const title = `Smoke Meeting ${stamp}`;
  const oldOffice = Users.findById(admin.id).board_role;
  const heldTreasurer = Users.listBoard().find((u) => u.board_role === 'treasurer');
  const wasPaused = Scheduler.isPaused();
  const mk = (tag, extra = '') => {
    const u = Users.createUser({ email: `smoke.sched.${tag}.${stamp}@example.com`, firstName: tag, lastName: 'Sched', role: 'member', status: 'active' });
    if (extra) run(extra, [u.id]);
    return u;
  };
  const a = mk('A');
  const b = mk('B', 'UPDATE users SET mail_reminders = 0 WHERE id = ?');
  const c = mk('C', "UPDATE users SET status = 'suspended' WHERE id = ?");
  const addEvent = (label, startsAt) =>
    Number(run(
      `INSERT INTO events (slug, title, starts_at, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'meeting', 'published', ?, ?)`,
      [`smoke-meeting-${label}-${stamp}`, `${title} ${label}`, startsAt.toISOString(), new Date().toISOString(), new Date().toISOString()]
    ).lastInsertRowid);
  const mailTo = (u, like) => get('SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [u.email, `%${like}%`]).n;
  const evt = (id) => get('SELECT * FROM events WHERE id = ?', [id]);

  // Administrators only: an officer who is not an admin cannot see it.
  run("UPDATE users SET role = 'member' WHERE id = ?", [admin.id]);
  Users.setBoardRole(admin.id, 'treasurer');
  let r = await req('/members/admin/schedule');
  record(r.status === 403, 'an officer who is not an administrator cannot open Scheduled emails', `-> ${r.status}`);
  run("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
  Users.setBoardRole(admin.id, null);
  r = await req('/members/admin/schedule');
  record(r.status === 200 && /Scheduled emails/.test(r.text), 'an administrator can, without holding an office');
  r = await req('/members');
  record(/href="[^"]*\/members\/admin\/schedule"/.test(r.text), 'the admin menu has an Automation tab');

  // The day-before reminder.
  const e1 = addEvent('one', zonedToUtc(2031, 3, 13, 19, 0));
  const due1 = Scheduler.reminderDueAt(evt(e1));
  record(toLocalInput(due1) === '2031-03-12T09:00', 'the reminder is due at 9:00 the morning before, chapter time', toLocalInput(due1));
  const early = new Date(due1.getTime() - 3600_000);
  let t = await Scheduler.tick({ now: early });
  record(!t.sent.length && mailTo(a, `${title} one`) === 0, 'nothing goes out before it is due');
  const at1 = new Date(due1.getTime() + 3600_000);
  t = await Scheduler.tick({ now: at1 });
  record(t.sent.some((x) => x.key.startsWith(`event:${e1}:`)), 'it goes out once it is due');
  record(mailTo(a, `${title} one`) === 1, 'an opted-in member gets it');
  record(mailTo(b, `${title} one`) === 0, 'a member who turned reminders off does not');
  record(mailTo(c, `${title} one`) === 0, 'a suspended member does not');
  const row = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [a.email, `%${title} one%`]);
  record(/\/unsubscribe\/[\w-]+\.[\w-]+/.test(row.body_text) && /List-Unsubscribe-Post/.test(row.headers ?? '') && /One-Click/.test(row.headers), 'it carries an unsubscribe link and the one-click header');
  record(/Thursday, March 13 at 7:00 PM/.test(row.body_text), 'the time reads in chapter time');
  record(/<table/.test(row.body_html ?? '') && row.body_html.includes(`${title} one`) && /\/unsubscribe\/[\w-]+\.[\w-]+/.test(row.body_html) && /Thursday, March 13 at 7:00 PM/.test(row.body_html), 'it also has a styled HTML version, with the details and unsubscribe link');
  const hostile = eventReminderEmail({
    name: '<b>N</b>', title: '<img src=x onerror=alert(1)> & Co', when: { long: 'Thursday', short: 'Thu' }, where: '<script>x</script>',
    summary: '"><svg onload=1>', rainDate: '<i>', link: 'https://x.test/?a=1&b="2"', unsubscribeLink: 'https://x.test/u', accountLink: 'https://x.test/a',
  });
  // The badge travels inside the message: no remote image, and it survives real MIME building.
  const parts = inlineAttachments(row.body_html);
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
    from: 'a@example.com', to: 'b@example.com', subject: 's', text: row.body_text, html: row.body_html, attachments: parts,
  });
  const mime = built.message.toString();
  record(!/<img[^>]+src="https?:/.test(row.body_html) && parts.length === 1 && fs.statSync(parts[0].path).size < 20_000 && /Content-ID: <eaa-logo>/i.test(mime) && /multipart\/related/.test(mime) && /<img[^>]+src="cid:eaa-logo"/.test(mime.replace(/=\r?\n/g, '').replace(/=3D/g, '=')), 'the badge is attached to the message itself (cid), not fetched from a website');
  record(!/<img src=x|<script|<svg|<b>N|<i>/.test(hostile.html) && hostile.html.includes('&lt;img src=x') && !hostile.html.includes('href="https://x.test/?a=1&b="'), 'markup in an event title or location cannot get into the HTML email');
  t = await Scheduler.tick({ now: at1 });
  record(!t.sent.length && mailTo(a, `${title} one`) === 1, 'a second run sends nothing more (no repeats)');

  // A meeting that moves gets a fresh reminder for its new date.
  run('UPDATE events SET starts_at = ? WHERE id = ?', [zonedToUtc(2031, 3, 20, 19, 0).toISOString(), e1]);
  t = await Scheduler.tick({ now: new Date(Scheduler.reminderDueAt(evt(e1)).getTime() + 3600_000) });
  record(t.sent.length === 1 && mailTo(a, `${title} one`) === 2, 'a moved meeting gets a new reminder for its new date');

  // Too late to be useful.
  const e2 = addEvent('two', zonedToUtc(2031, 4, 10, 19, 0));
  t = await Scheduler.tick({ now: new Date(Scheduler.reminderDueAt(evt(e2)).getTime() + 20 * 3600_000) });
  record(t.skipped.length === 1 && mailTo(a, `${title} two`) === 0, 'a reminder more than 18 hours late is skipped, not sent');

  // Unsubscribe. The links are signed with SESSION_SECRET, which a development server
  // makes up afresh at every start, so these checks only work when this script and the
  // server share one (SESSION_SECRET=... for both). Otherwise say so rather than fail.
  const tok = makeToken(a.id, 'reminders');
  const shared = (await fetch(`${BASE}/unsubscribe/${tok}`)).status === 200;
  if (!shared) {
    realLog('  skip unsubscribe link checks: the server signs with a different SESSION_SECRET than this script (set the same one for both to run them)');
  } else {
    r = await req(`/unsubscribe/${tok}`);
    record(r.status === 200 && /Unsubscribe/.test(r.text) && Users.findById(a.id).mail_reminders === 1, 'the link asks first; opening it changes nothing');
    r = await req(`/unsubscribe/${tok}`, { method: 'POST', body: {} });
    record(r.status === 200 && Users.findById(a.id).mail_reminders === 0 && Users.findById(a.id).mail_newsletter === 1, 'confirming turns off that one category only');
    r = await req(`/unsubscribe/${tok}/resubscribe`, { method: 'POST', body: {} });
    record(Users.findById(a.id).mail_reminders === 1, 'and it can be turned back on');
    const oneClick = await fetch(`${BASE}/unsubscribe/${tok}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    record(oneClick.status === 200 && Users.findById(a.id).mail_reminders === 0, "a mail client's one-click button works with no login or form token", `-> ${oneClick.status}`);
    const bad = await fetch(`${BASE}/unsubscribe/${tok.slice(0, -2)}xx`, { method: 'POST' });
    await fetch(`${BASE}/unsubscribe/${makeToken(b.id, 'newsletter')}`, { method: 'POST' });
    record(bad.status === 404 && Users.findById(b.id).mail_newsletter === 0 && Users.findById(b.id).mail_meeting_notices === 1, 'a forged link does nothing; a real one affects only its own category');
    const ghost = await fetch(`${BASE}/unsubscribe/${makeToken(999999, 'reminders')}`, { method: 'POST' });
    record(ghost.status === 404, 'a link for nobody is refused');
  }
  run('UPDATE users SET mail_reminders = 0 WHERE id = ?', [a.id]); // opted out, whichever way

  // Pause, and the officers' page.
  const e3 = addEvent('three', zonedToUtc(2031, 5, 8, 19, 0));
  const at3 = new Date(Scheduler.reminderDueAt(evt(e3)).getTime() + 3600_000);
  Scheduler.setPaused(true);
  t = await Scheduler.tick({ now: at3 });
  record(t.paused && !t.sent.length && !get('SELECT 1 AS x FROM scheduled_sends WHERE occurrence_key LIKE ?', [`event:${e3}:%`]), 'while paused nothing is sent or recorded');
  Scheduler.setPaused(false);
  t = await Scheduler.tick({ now: at3 });
  const someoneElse = Users.listMembers({ status: 'active' }).find((m) => m.id !== a.id && m.id !== b.id && !m.email.startsWith('smoke.'));
  record(t.sent.length === 1 && mailTo(a, `${title} three`) === 0 && mailTo(someoneElse, `${title} three`) === 1, 'resumed, it sends, and still leaves out the member who opted out');

  const near = addEvent('near', new Date(Date.now() + 10 * 86_400_000));
  const nearKey = Scheduler.plan().find((p) => p.event.id === near)?.key;
  let page = await req('/members/admin/schedule');
  record(Boolean(nearKey) && page.text.includes(`${title} near`) && /Scheduled/.test(page.text), 'the page lists an upcoming reminder');
  r = await req('/members/admin/schedule/skip', { method: 'POST', body: { _csrf: csrfFrom(page.text), key: nearKey } });
  record(Scheduler.plan().find((p) => p.key === nearKey)?.state === 'skipped', 'an officer can skip it');
  r = await Scheduler.tick({ now: new Date(Scheduler.reminderDueAt(evt(near)).getTime() + 3600_000) });
  record(mailTo(a, `${title} near`) === 0, 'a skipped reminder is not sent');
  page = await req('/members/admin/schedule');
  r = await req('/members/admin/schedule/skip', { method: 'POST', body: { _csrf: csrfFrom(page.text), key: nearKey, undo: '1' } });
  record(Scheduler.plan().find((p) => p.key === nearKey)?.state === 'scheduled', 'and restored');
  r = await req('/members/admin/schedule/test', { method: 'POST', body: { _csrf: csrfFrom(page.text), key: nearKey } });
  record(mailTo(admin, '[TEST]') >= 1, 'an officer can email themselves a test copy');
  r = await req('/members/admin/schedule/pause', { method: 'POST', body: { _csrf: csrfFrom(page.text), paused: '1' } });
  record(Scheduler.isPaused(), 'the page can pause sending');
  Scheduler.setPaused(false);

  // Clean up.
  for (const id of [e1, e2, e3, near]) {
    run('DELETE FROM notices WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM scheduled_sends WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM events WHERE id = ?', [id]);
  }
  run('DELETE FROM email_outbox WHERE subject LIKE ?', [`%${title}%`]);
  run("DELETE FROM email_outbox WHERE to_addr = ? AND subject LIKE '[TEST]%'", [admin.email]);
  for (const u of [a, b, c]) {
    run('DELETE FROM email_outbox WHERE to_addr = ?', [u.email]);
    run('DELETE FROM users WHERE id = ?', [u.id]);
  }
  Scheduler.setPaused(wasPaused);
  console.log = realLog;
  Users.setBoardRole(admin.id, oldOffice);
  if (heldTreasurer && !Users.findById(heldTreasurer.id).board_role) Users.setBoardRole(heldTreasurer.id, 'treasurer');
}

console.log('\nMeeting notices');
{
  const realLog = console.log;
  console.log = (...args) => {
    const first = String(args[0] ?? '');
    if (first.includes('outbox #') || first.startsWith('[scheduler]') || first.startsWith('[notices]')) return;
    realLog(...args);
  };
  const stamp = Date.now();
  const title = `Smoke Notice ${stamp}`;
  const oldOffice = Users.findById(admin.id).board_role;
  const heldPres = Users.listBoard().find((u) => u.board_role === 'president');
  const heldVp = Users.listBoard().find((u) => u.board_role === 'vice_president');
  const heldSec = Users.listBoard().find((u) => u.board_role === 'secretary');
  const wasPaused = Scheduler.isPaused();
  const mk = (tag, extra = '') => {
    const u = Users.createUser({ email: `smoke.notice.${tag}.${stamp}@example.com`, firstName: tag, lastName: 'Notice', role: 'member', status: 'active' });
    if (extra) run(extra, [u.id]);
    return u;
  };
  const vp = mk('VP');
  const ma = mk('A');
  const mb = mk('B', 'UPDATE users SET mail_meeting_notices = 0 WHERE id = ?');
  Users.setBoardRole(vp.id, 'vice_president');
  Users.setBoardRole(admin.id, null);
  const addEvent = (label, startsAt) =>
    Number(run(
      `INSERT INTO events (slug, title, starts_at, kind, status, location_name, city, state, created_at, updated_at)
       VALUES (?, ?, ?, 'meeting', 'published', 'Hangar 2', 'Selkirk', 'NY', ?, ?)`,
      [`smoke-notice-${label}-${stamp}`, `${title} ${label}`, startsAt.toISOString(), new Date().toISOString(), new Date().toISOString()]
    ).lastInsertRowid);
  const noticeFor = (eventId) => get('SELECT * FROM notices WHERE event_id = ? ORDER BY id DESC', [eventId]);
  const mailTo = (u, like) => get('SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [u.email, `%${like}%`]).n;
  const days = (d, from) => new Date(from.getTime() + d * 86_400_000);
  const ids = [];
  const run_ = (now) => Notices.runNotices({ now });

  // Drafting, about two weeks out.
  const start1 = zonedToUtc(2031, 6, 12, 19, 0);
  const e1 = addEvent('one', start1); ids.push(e1);
  await run_(days(-15, start1));
  record(!noticeFor(e1), 'no notice is drafted more than two weeks before a meeting');
  await run_(days(-13, start1));
  const n1 = noticeFor(e1);
  record(n1?.status === 'draft', 'a draft is made about two weeks out');
  record(toLocalInput(n1.send_at) === '2031-06-02T09:00', 'it is due ten days before, at 9:00 chapter time', toLocalInput(n1?.send_at));
  record(mailTo(vp, 'Meeting notice to approve') === 1, 'the Vice President is told it is ready');
  await run_(days(-13, start1));
  record(mailTo(vp, 'Meeting notice to approve') === 1 && get('SELECT COUNT(*) AS n FROM notices WHERE event_id = ?', [e1]).n === 1, 'running again makes no second draft or email');

  // Unapproved: chased daily, never sent.
  const due1 = new Date(n1.send_at);
  await run_(new Date(due1.getTime() + 3600_000));
  record(mailTo(vp, 'Still waiting for approval') === 1, 'when due and unapproved, the approvers are chased');
  await run_(new Date(due1.getTime() + 2 * 3600_000));
  record(mailTo(vp, 'Still waiting for approval') === 1, 'but only once a day');
  await run_(new Date(due1.getTime() + 26 * 3600_000));
  record(mailTo(vp, 'Still waiting for approval') === 2, 'and again the next day');
  record(mailTo(ma, `${title} one`) === 0 && noticeFor(e1).status === 'draft', 'an unapproved notice is never sent');

  // Who can do what.
  Users.setBoardRole(admin.id, 'secretary');
  let page = await req(`/members/documents/notices/${n1.id}`);
  record(page.status === 200 && /Needs approval/.test(page.text) && page.text.includes('Approve this notice'), 'the secretary can open it and is offered Approve', `-> ${page.status}`);
  let r = await req(`/members/documents/notices/${n1.id}`, { method: 'POST', body: { _csrf: csrfFrom(page.text), subject: 'Ready for the board', speaker: 'Pat Pilot: owning a Cub', agenda: '- Treasurer report\n- Fly-out planning\n3. Raffle', note: 'First paragraph.\n\nSecond paragraph.' } });
  record(noticeFor(e1).speaker?.startsWith('Pat Pilot') && noticeFor(e1).subject === 'Ready for the board', 'any officer can write the wording');
  Users.setBoardRole(admin.id, 'treasurer');
  page = await req(`/members/documents/notices/${n1.id}`);
  r = await req(`/members/documents/notices/${n1.id}/approve`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(!page.text.includes('Approve this notice') && r.status === 403 && noticeFor(e1).status === 'draft', 'the treasurer cannot approve', `-> ${r.status}`);
  Users.setBoardRole(admin.id, null);
  r = await req(`/members/documents/notices/${n1.id}`);
  record(r.status === 403, 'an administrator who is not an officer cannot open it', `-> ${r.status}`);

  // Approval, and what withdraws it.
  Users.setBoardRole(admin.id, 'president');
  page = await req(`/members/documents/notices/${n1.id}`);
  record(page.text.includes('Approve this notice'), 'the President is offered Approve');
  await req(`/members/documents/notices/${n1.id}/approve`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(noticeFor(e1).status === 'approved' && /President/.test(noticeFor(e1).approved_label ?? ''), 'the President approves; the record keeps the name and office');
  page = await req(`/members/documents/notices/${n1.id}`);
  await req(`/members/documents/notices/${n1.id}`, { method: 'POST', body: { _csrf: csrfFrom(page.text), subject: 'Ready for the board', speaker: 'Pat Pilot: owning a Cub (changed)', agenda: '- Treasurer report', note: '' } });
  record(noticeFor(e1).status === 'draft' && !noticeFor(e1).approved_by, 'editing an approved notice withdraws the approval');
  page = await req(`/members/documents/notices/${n1.id}`);
  await req(`/members/documents/notices/${n1.id}/approve`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  run("UPDATE events SET location_name = 'Hangar 3' WHERE id = ?", [e1]);
  const heads = mailTo(vp, 'Approval withdrawn');
  await run_(new Date(due1.getTime() + 3600_000));
  record(noticeFor(e1).status === 'draft' && mailTo(vp, 'Approval withdrawn') === heads + 1 && mailTo(ma, `${title} one`) === 0, 'changing the place after approval withdraws it, tells the approvers and sends nothing');
  page = await req(`/members/documents/notices/${n1.id}`);
  await req(`/members/documents/notices/${n1.id}/approve`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(noticeFor(e1).status === 'approved', 'it can be approved again');

  // Sending.
  const sendAt = new Date(noticeFor(e1).send_at);
  await run_(new Date(sendAt.getTime() - 3600_000));
  record(mailTo(ma, `${title} one`) === 0, 'an approved notice waits for its time');
  await run_(new Date(sendAt.getTime() + 3600_000));
  const sent = noticeFor(e1);
  record(sent.status === 'sent' && mailTo(ma, 'Meeting notice:') === 1, 'at its time an approved notice goes to members');
  record(mailTo(mb, 'Meeting notice:') === 0, 'a member who turned meeting notices off does not get it');
  const mail = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [ma.email, '%Meeting notice:%']);
  record(/Pat Pilot/.test(mail.body_text) && /Treasurer report/.test(mail.body_html) && /Hangar 3/.test(mail.body_text) && /\/unsubscribe\//.test(mail.body_html) && /List-Unsubscribe/.test(mail.headers ?? ''), 'it carries the speaker, agenda, new place and an unsubscribe link');
  const post = sent.post_id && get('SELECT * FROM posts WHERE id = ?', [sent.post_id]);
  record(post?.status === 'published' && post.visibility === 'public' && /Treasurer report/.test(post.body_md), 'it is also posted on the website');
  await run_(new Date(sendAt.getTime() + 7200_000));
  record(mailTo(ma, 'Meeting notice:') === 1, 'it is never sent twice');

  // Approved late: goes at the next run.
  const start2 = zonedToUtc(2031, 7, 10, 19, 0);
  const e2 = addEvent('two', start2); ids.push(e2);
  await run_(days(-13, start2));
  const n2 = noticeFor(e2);
  const late = new Date(new Date(n2.send_at).getTime() + 30 * 3600_000);
  Notices.approve(n2.id, Users.findById(admin.id), { now: late });
  await run_(late);
  record(noticeFor(e2).status === 'sent', 'approved after its time, it goes at the next run');

  // Too close to the meeting.
  const start3 = zonedToUtc(2031, 8, 14, 19, 0);
  const e3 = addEvent('three', start3); ids.push(e3);
  await run_(days(-13, start3));
  const n3 = noticeFor(e3);
  const closing = new Date(start3.getTime() - 47 * 3600_000);
  const refused = Notices.approve(n3.id, Users.findById(admin.id), { now: closing });
  await run_(closing);
  record(!refused.ok && noticeFor(e3).status === 'cancelled' && mailTo(ma, `${title} three`) === 0 && mailTo(vp, 'No meeting notice sent') >= 1, 'inside the last 48 hours nothing is sent; the approvers are told');

  // A meeting that moves.
  const start4 = zonedToUtc(2031, 9, 11, 19, 0);
  const e4 = addEvent('four', start4); ids.push(e4);
  await run_(days(-13, start4));
  const n4 = noticeFor(e4);
  Notices.approve(n4.id, Users.findById(admin.id), { now: days(-12, start4) });
  run('UPDATE events SET starts_at = ? WHERE id = ?', [zonedToUtc(2031, 9, 18, 19, 0).toISOString(), e4]);
  await run_(days(-5, start4));
  const old4 = get('SELECT * FROM notices WHERE id = ?', [n4.id]);
  const fresh4 = noticeFor(e4);
  record(old4.status === 'cancelled' && fresh4.id !== n4.id && fresh4.status === 'draft', 'a meeting that moves loses its approval and gets a new draft');
  record(mailTo(ma, `${title} four`) === 0, 'and the old approval sends nothing');
  // The Secretary can approve a notice too.
  Users.setBoardRole(admin.id, 'secretary');
  page = await req(`/members/documents/notices/${fresh4.id}`);
  await req(`/members/documents/notices/${fresh4.id}/approve`, { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(noticeFor(e4).status === 'approved' && /Secretary/.test(noticeFor(e4).approved_label ?? ''), 'the Secretary can approve a notice; the record keeps the office');
  record(Users.listBoard().filter((u) => Users.canApproveNotice(u)).some((u) => u.id === admin.id), 'and is among those told when one needs approving');

  // The pages, the badge, and pause.
  page = await req('/members/documents/board');
  record(/Meeting notices/.test(page.text) && page.text.includes(`${title} four`), 'the board page lists the notices');
  const e5 = addEvent('five', zonedToUtc(2031, 10, 9, 19, 0)); ids.push(e5);
  Scheduler.setPaused(true);
  await Scheduler.tick({ now: days(-13, zonedToUtc(2031, 10, 9, 19, 0)) });
  record(!noticeFor(e5), 'while paused no notice is drafted');
  Scheduler.setPaused(false);
  await Scheduler.tick({ now: days(-13, zonedToUtc(2031, 10, 9, 19, 0)) });
  record(Boolean(noticeFor(e5)), 'the scheduler tick also runs the notices');
  r = await req('/members/documents/notices/' + noticeFor(e5).id + '/preview', { method: 'POST', body: { _csrf: csrfFrom(page.text) } });
  record(mailTo(admin, '[PREVIEW]') >= 1, 'an officer can email themselves a preview');

  // Nothing a person types can inject markup.
  const hostile = meetingNoticeEmail({
    name: '<b>N</b>', title: '<img src=x onerror=1>', when: { long: 'Thu', short: 'Thu' }, where: '<script>x</script>',
    speaker: '<svg onload=1>', agenda: '<i>one</i>\n- "><u>two', note: '<a href=javascript:1>hi</a>', rainDate: '<s>', link: 'https://x.test/e', unsubscribeLink: 'https://x.test/u', accountLink: 'https://x.test/a',
  });
  record(!/<img src=x|<script|<svg|<b>N|<i>one|<u>two|<s>|<a href=javascript/.test(hostile.html), 'markup in a notice cannot get into the HTML email');

  // Clean up.
  for (const id of ids) {
    run('DELETE FROM notices WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM scheduled_sends WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM events WHERE id = ?', [id]);
  }
  run("DELETE FROM posts WHERE title LIKE ?", [`${title}%`]);
  run('DELETE FROM email_outbox WHERE subject LIKE ?', [`%${title}%`]);
  run("DELETE FROM email_outbox WHERE to_addr = ? AND subject LIKE '[PREVIEW]%'", [admin.email]);
  for (const u of [vp, ma, mb]) {
    run('DELETE FROM email_outbox WHERE to_addr = ?', [u.email]);
    run('DELETE FROM users WHERE id = ?', [u.id]);
  }
  Scheduler.setPaused(wasPaused);
  console.log = realLog;
  Users.setBoardRole(admin.id, oldOffice);
  for (const [u, office] of [[heldPres, 'president'], [heldVp, 'vice_president'], [heldSec, 'secretary']]) {
    if (u && !Users.findById(u.id).board_role && Users.findById(u.id)) Users.setBoardRole(u.id, office);
  }
}

console.log('\nDashboard to do');
{
  const stamp = Date.now();
  const oldRole = admin.role;
  const oldOffice = Users.findById(admin.id).board_role;
  const held = ['president', 'vice_president', 'secretary', 'treasurer'].map((o) => [o, Users.listBoard().find((u) => u.board_role === o)]);
  const wasPaused = Scheduler.isPaused();
  const t = (suffix) => `Mock ${suffix} ${stamp}`;
  const ts = new Date().toISOString();
  const addDoc = (suffix, status, createdBy, { submittedBy = null, published = false } = {}) => {
    const id = Number(run(
      `INSERT INTO documents (kind, title, status, visibility, created_by, created_at, updated_at, next_version)
       VALUES ('minutes', ?, ?, 'board', ?, ?, ?, 2)`, [t(suffix), status, createdBy, ts, ts]
    ).lastInsertRowid);
    const vid = Number(run(
      `INSERT INTO document_versions (document_id, number, original_name, stored_name, mime, size, sha256, created_by, created_at, submitted_by, submitted_at)
       VALUES (?, 1, 'x.pdf', ?, 'application/pdf', 1, 'ab', ?, ?, ?, ?)`, [id, `${stamp}${id}`.padEnd(32, '0').slice(0, 32), createdBy, ts, submittedBy, submittedBy ? ts : null]
    ).lastInsertRowid);
    if (published) run('UPDATE documents SET published_version_id = ? WHERE id = ?', [vid, id]);
    return id;
  };
  const docA = addDoc('A review', 'in_review', admin.id, { submittedBy: admin.id });
  const docB = addDoc('B changes', 'changes_requested', admin.id, { submittedBy: admin.id });
  const docC = addDoc('C publish', 'approved', null);
  const docD = addDoc('D draft', 'draft', admin.id);
  const evt = Number(run(
    `INSERT INTO events (slug, title, starts_at, kind, status, created_at, updated_at)
     VALUES (?, ?, ?, 'meeting', 'published', ?, ?)`, [`mock-todo-${stamp}`, t('Meeting'), new Date(Date.now() + 10 * 86_400_000).toISOString(), ts, ts]
  ).lastInsertRowid);
  run(`INSERT INTO notices (event_id, occurrence_key, subject, status, send_at, created_at, updated_at)
       VALUES (?, ?, 'x', 'draft', ?, ?, ?)`, [evt, `event:${evt}:mock-${stamp}`, new Date(Date.now() - 86_400_000).toISOString(), ts, ts]);
  const app = Number(run(`INSERT INTO membership_applications (first_name, last_name, email, message, created_at) VALUES ('Mock', 'Applicant', ?, 'hi', ?)`, [`mock.todo.${stamp}@example.com`, ts]).lastInsertRowid);
  const msg = Number(run(`INSERT INTO contact_messages (name, email, message, created_at) VALUES ('Mock', ?, 'hi', ?)`, [`mock.todo.${stamp}@example.com`, ts]).lastInsertRowid);

  const as = async (role, office) => {
    run('UPDATE users SET role = ? WHERE id = ?', [role, admin.id]);
    Users.setBoardRole(admin.id, office);
    return (await req('/members')).text;
  };
  const has = (html, text) => html.includes(text);

  let h = await as('member', null);
  record(!has(h, 'id="todo-heading"'), 'an ordinary member has no To do section');

  h = await as('member', 'president');
  record(has(h, 'id="todo-heading"') && has(h, `Review: ${t('A review')}`) && has(h, `Approve the notice for ${t('Meeting')}`) && has(h, `Publish: ${t('C publish')}`), 'the President sees documents to review and publish, and notices to approve');
  record(has(h, `Changes requested: ${t('B changes')}`) && has(h, `Send for review: ${t('D draft')}`), 'and their own documents that need them');
  record(!has(h, 'membership request') && !has(h, 'to answer'), 'but none of the administrator items');
  record(/Was due|already/.test(h) || has(h, 'It was due to go to members already'), 'an overdue notice says so');

  h = await as('member', 'secretary');
  record(!has(h, `Review: ${t('A review')}`) && has(h, `Approve the notice for ${t('Meeting')}`) && has(h, `Publish: ${t('C publish')}`), 'the Secretary approves notices and publishes, but does not review documents');

  h = await as('member', 'treasurer');
  record(!has(h, 'Approve the notice') && !has(h, 'Publish:') && !has(h, 'Review:') && has(h, `Changes requested: ${t('B changes')}`), 'the Treasurer sees only their own documents');

  h = await as('admin', null);
  record(has(h, 'membership request') && has(h, 'to answer') && !has(h, 'Approve the notice') && !has(h, `Review: ${t('A review')}`), 'an administrator who is not an officer sees site items, not the board\'s');
  Scheduler.setPaused(true);
  h = (await req('/members')).text;
  record(has(h, 'Scheduled sending is paused'), 'and is told when sending is paused');
  Scheduler.setPaused(wasPaused);

  for (const id of [docA, docB, docC, docD]) run('DELETE FROM documents WHERE id = ?', [id]);
  h = await as('member', 'treasurer');
  record(has(h, 'id="todo-heading"') && has(h, 'all caught up'), 'an officer with nothing waiting is told so');

  run('DELETE FROM notices WHERE event_id = ?', [evt]);
  run('DELETE FROM events WHERE id = ?', [evt]);
  run('DELETE FROM membership_applications WHERE id = ?', [app]);
  run('DELETE FROM contact_messages WHERE id = ?', [msg]);
  run('UPDATE users SET role = ? WHERE id = ?', [oldRole, admin.id]);
  Users.setBoardRole(admin.id, oldOffice);
  for (const [office, u] of held) if (u && !Users.findById(u.id).board_role) Users.setBoardRole(u.id, office);
}

console.log('\nReminders for every kind of event, and updates');
{
  const realLog = console.log;
  console.log = (...args) => {
    const first = String(args[0] ?? '');
    if (first.includes('outbox #') || first.startsWith('[scheduler]') || first.startsWith('[notices]')) return;
    realLog(...args);
  };
  const stamp = Date.now();
  const title = `Smoke Kind ${stamp}`;
  const oldRole = admin.role;
  const wasPaused = Scheduler.isPaused();
  const mk = (tag, extra = '') => {
    const u = Users.createUser({ email: `smoke.kind.${tag}.${stamp}@example.com`, firstName: tag, lastName: 'Kind', role: 'member', status: 'active' });
    if (extra) run(extra, [u.id]);
    return u;
  };
  const a = mk('A');
  const b = mk('B', 'UPDATE users SET mail_reminders = 0 WHERE id = ?');
  const ids = [];
  const addEvent = (label, kind, startsAt, extra = {}) => {
    const id = Number(run(
      `INSERT INTO events (slug, title, starts_at, kind, status, reminders, rain_date, location_name, city, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Hangar 2', 'Selkirk', 'NY', ?, ?)`,
      [`smoke-kind-${label}-${stamp}`, `${title} ${label}`, startsAt.toISOString(), kind, extra.status ?? 'published', extra.reminders ?? null,
        extra.rain ?? null, new Date().toISOString(), new Date().toISOString()]
    ).lastInsertRowid);
    ids.push(id);
    return id;
  };
  const mailTo = (u, like) => get('SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [u.email, `%${like}%`]).n;
  const items = (id, now) => Scheduler.plan({ now }).filter((p) => p.event.id === id).map((p) => p.lead);
  const start = zonedToUtc(2031, 11, 13, 19, 0);
  const before = new Date(start.getTime() - 20 * 86_400_000);

  // What each type sends by default.
  const expected = { meeting: ['day'], workshop: ['day'], 'fly-in': ['week', 'day'], 'young-eagles': ['week', 'day'], social: [], chapter: [] };
  for (const [kind, leads] of Object.entries(expected)) {
    const id = addEvent(`k-${kind}`, kind, start);
    record(JSON.stringify(items(id, before)) === JSON.stringify(leads), `a ${kind} event sends ${leads.length ? leads.join(' and ') : 'no'} reminder${leads.length === 1 ? '' : 's'} by default`, JSON.stringify(items(id, before)));
  }
  record(items(addEvent('s-day', 'social', start, { reminders: 'day' }), before).join() === 'day', 'a social can be given a reminder');
  record(items(addEvent('m-off', 'meeting', start, { reminders: 'off' }), before).length === 0, 'a meeting can have its reminder switched off');
  record(items(addEvent('w-both', 'workshop', start, { reminders: 'week_and_day' }), before).join() === 'week,day', 'a workshop can be given both');
  record(items(addEvent('draft', 'fly-in', start, { status: 'draft' }), before).length === 0 && items(addEvent('cxl', 'fly-in', start, { status: 'cancelled' }), before).length === 0, 'drafts and cancelled events get none');

  // A fly-in: a week before, then the day before; members who opted out are left out.
  const fly = addEvent('plane', 'fly-in', start, { rain: zonedToUtc(2031, 11, 14, 0, 0).toISOString() });
  const weekDue = Scheduler.reminderDueAt(get('SELECT * FROM events WHERE id = ?', [fly]), 'week');
  const dayDue = Scheduler.reminderDueAt(get('SELECT * FROM events WHERE id = ?', [fly]), 'day');
  record(toLocalInput(weekDue) === '2031-11-06T09:00' && toLocalInput(dayDue) === '2031-11-12T09:00', 'the week-before reminder is 9:00 a week ahead, the other the morning before');
  await Scheduler.tick({ now: new Date(weekDue.getTime() + 3600_000) });
  record(mailTo(a, `Coming up: ${title} plane`) === 1 && mailTo(a, `Reminder: ${title} plane`) === 0, 'a week ahead, members get the first reminder');
  record(mailTo(b, `${title} plane`) === 0, 'a member who turned reminders off gets neither');
  const wk = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [a.email, `Coming up: ${title} plane%`]);
  record(/a week away/.test(wk.body_text) && /Rain date: Friday, November 14/.test(wk.body_text) && !/2031-1/.test(wk.body_text) && /\/unsubscribe\//.test(wk.body_html), 'it reads right: a week away, a proper rain date, an unsubscribe link');
  await Scheduler.tick({ now: new Date(weekDue.getTime() + 2 * 3600_000) });
  record(mailTo(a, `Coming up: ${title} plane`) === 1, 'it is not sent twice');
  await Scheduler.tick({ now: new Date(dayDue.getTime() + 3600_000) });
  record(mailTo(a, `Reminder: ${title} plane`) === 1 && mailTo(a, `Coming up: ${title} plane`) === 1, 'the day before, the second one goes');

  // The event form carries the setting.
  const form = await req('/members/admin/events/new');
  record(/name="reminders"/.test(form.text), 'the event form has the reminders setting');
  let r = await multipart('/members/admin/events/new', {
    _csrf: csrfFrom(form.text), title: `${title} Form`, starts_at: '2031-12-11T19:00', kind: 'workshop', status: 'published', reminders: 'week_and_day',
  });
  const made = get('SELECT * FROM events WHERE title = ?', [`${title} Form`]);
  if (made) ids.push(made.id);
  record(made?.reminders === 'week_and_day', 'it is saved with the event', `-> ${r.status}`);
  const edit = await req(`/members/admin/events/${made.id}/edit`);
  record(/<option value="week_and_day" selected>/.test(edit.text), 'and shown again when editing');

  // Telling members about a change.
  run("UPDATE users SET role = 'admin' WHERE id = ?", [admin.id]);
  const ev = fly;
  const send = (kind, message, action = 'send', extra = {}) =>
    req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(edit.text), kind, message, action, ...extra } });
  const page = await req(`/members/admin/events/${ev}/edit`);
  record(/Tell members about a change/.test(page.text), 'an event has a "Tell members about a change" box');
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'ok', action: 'preview' } });
  record(r.status === 302 && mailTo(admin, '[PREVIEW]') === 0, 'a message that is too short is refused');
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'Moved to <b>10 AM</b> because of the forecast.', action: 'preview' } });
  record(mailTo(admin, '[PREVIEW] Update') === 1 && mailTo(a, 'Update:') === 0, 'a preview goes only to the editor');
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'Moved to <b>10 AM</b> because of the forecast.', action: 'send' } });
  const upd = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject = ?', [a.email, `Update: ${title} plane`]);
  record(Boolean(upd) && mailTo(b, 'Update:') === 0, 'sending reaches members who have reminders on, and not those who turned them off');
  record(/Moved to <b>10 AM<\/b>/.test(upd.body_text) && !/<b>10 AM/.test(upd.body_html) && /&lt;b&gt;10 AM/.test(upd.body_html), "the editor's words cannot inject markup");
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'Moved to <b>10 AM</b> because of the forecast.', action: 'send' } });
  record(mailTo(a, 'Update:') === 1, 'the same message is not sent twice by a double click');
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'cancelled', message: 'Cancelled for weather. We will pick a new date soon.', action: 'send', mark_cancelled: '1' } });
  record(mailTo(a, `Cancelled: ${title} plane`) === 1 && get('SELECT status FROM events WHERE id = ?', [ev]).status === 'cancelled', 'a cancellation is sent and the event is marked cancelled');
  record(items(ev, new Date(dayDue.getTime() - 86_400_000)).length === 0, 'so no further reminders are planned for it');
  record(get('SELECT COUNT(*) AS n FROM event_updates WHERE event_id = ?', [ev]).n === 2, 'each message is recorded');
  const draftEvent = get('SELECT id FROM events WHERE slug = ?', [`smoke-kind-draft-${stamp}`]).id;
  r = await req(`/members/admin/events/${draftEvent}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'Something changed.', action: 'send' } });
  record(get('SELECT COUNT(*) AS n FROM event_updates WHERE event_id = ?', [draftEvent]).n === 0, 'nothing is sent about a draft event');
  run("UPDATE users SET role = 'member' WHERE id = ?", [admin.id]);
  r = await req(`/members/admin/events/${ev}/update`, { method: 'POST', body: { _csrf: csrfFrom(page.text), kind: 'update', message: 'Not allowed to send this.', action: 'send' } });
  record(r.status === 403 && get('SELECT COUNT(*) AS n FROM event_updates WHERE event_id = ?', [ev]).n === 2, 'an ordinary member cannot send one', `-> ${r.status}`);
  run('UPDATE users SET role = ? WHERE id = ?', [oldRole, admin.id]);

  const hostile = eventUpdateEmail({
    name: '<b>N</b>', title: '<img src=x onerror=1>', cancelled: true, message: '<script>x</script>\n\n"><svg onload=1>', when: { long: 'Thu', short: 'Thu' }, where: '<i>', link: 'https://x.test/e', unsubscribeLink: 'https://x.test/u', accountLink: 'https://x.test/a',
  });
  record(!/<img src=x|<script|<svg|<b>N|<i>/.test(hostile.html), 'markup cannot get into an update email');

  for (const id of ids) {
    run('DELETE FROM event_updates WHERE event_id = ?', [id]);
    run('DELETE FROM scheduled_sends WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM notices WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM events WHERE id = ?', [id]);
  }
  run('DELETE FROM email_outbox WHERE subject LIKE ?', [`%${title}%`]);
  run("DELETE FROM email_outbox WHERE to_addr = ? AND subject LIKE '[PREVIEW]%'", [admin.email]);
  for (const u of [a, b]) {
    run('DELETE FROM email_outbox WHERE to_addr = ?', [u.email]);
    run('DELETE FROM users WHERE id = ?', [u.id]);
  }
  Scheduler.setPaused(wasPaused);
  console.log = realLog;
}

console.log('\nEvery member-facing email has an HTML version');
{
  const evil = '<img src=x onerror=1><script>x</script>"><svg onload=1>';
  const link = 'https://example.test/path?a=1&b=2';
  const mails = {
    reset: Mail.passwordResetEmail({ name: evil, link, ttlMinutes: 60 }),
    invite: Mail.inviteEmail({ name: evil, link, invitedBy: evil, ttlDays: 14 }),
    borrowRequest: Mail.borrowRequestEmail({ ownerName: evil, requesterName: evil, toolName: evil, message: evil, link, neededFrom: null, neededTo: null }),
    borrowDecision: Mail.borrowDecisionEmail({ requesterName: evil, toolName: evil, ownerName: evil, status: 'approved', reply: evil, link }),
    applicationReceived: Mail.applicationReceivedEmail({ name: evil }),
    applicationNotification: Mail.applicationNotificationEmail({ name: evil, email: evil, interest: evil, message: evil, link }),
    applicationDeclined: Mail.applicationDeclinedEmail({ name: evil, note: evil }),
    documentSubmitted: Mail.documentSubmittedEmail({ reviewerName: evil, submitterName: evil, title: evil, kind: 'Meeting minutes', version: 2, link }),
    documentReviewed: Mail.documentReviewedEmail({ name: evil, reviewerName: evil, reviewerOffice: 'President', title: evil, decision: 'changes_requested', comment: evil, link }),
  };
  for (const [name, m] of Object.entries(mails)) {
    record(/<table/.test(m.html ?? '') && !/<img src=x|<script|<svg/.test(m.html) && m.text.length > 40, `${name}: has styled HTML, nothing injectable, and a plain-text copy`);
  }
  const reset = Mail.passwordResetEmail({ name: 'Ann', link, ttlMinutes: 60 });
  record(reset.text.includes(link) && reset.html.includes('href="https://example.test/path?a=1&amp;b=2"') && reset.html.split('https://example.test/path?a=1&amp;b=2').length - 1 >= 2, 'the reset link is a button and also pasted in full, in both copies');
  const sent = get("SELECT body_text, body_html FROM email_outbox WHERE subject = 'Reset your EAA Chapter 1699 password' ORDER BY id DESC LIMIT 1");
  record(!sent || (/<table/.test(sent.body_html ?? '') && /\/reset\//.test(sent.body_html) && /\/reset\//.test(sent.body_text)), 'a real reset request queues both versions');
}

console.log('\nMeeting minutes follow-up');
{
  const realLog = console.log;
  console.log = (...args) => {
    const first = String(args[0] ?? '');
    if (first.includes('outbox #') || first.startsWith('[scheduler]') || first.startsWith('[notices]')) return;
    realLog(...args);
  };
  const stamp = Date.now();
  const title = `Smoke Minutes ${stamp}`;
  const oldRole = admin.role;
  const oldOffice = Users.findById(admin.id).board_role;
  const held = ['president', 'vice_president', 'secretary'].map((o) => [o, Users.listBoard().find((u) => u.board_role === o)]);
  const wasPaused = Scheduler.isPaused();
  const mk = (tag, extra = '') => {
    const u = Users.createUser({ email: `smoke.min.${tag}.${stamp}@example.com`, firstName: tag, lastName: 'Min', role: 'member', status: 'active' });
    if (extra) run(extra, [u.id]);
    return u;
  };
  const sec = mk('Sec'); const pres = mk('Pres'); const vp = mk('Vp'); const ma = mk('A'); const mb = mk('B', 'UPDATE users SET mail_meeting_notices = 0 WHERE id = ?');
  Users.setBoardRole(sec.id, 'secretary'); Users.setBoardRole(pres.id, 'president'); Users.setBoardRole(vp.id, 'vice_president');
  Users.setBoardRole(admin.id, null);
  const ids = []; const docs = [];
  const addEvent = (label, startsAt, expected = 1) => {
    const id = Number(run(
      `INSERT INTO events (slug, title, starts_at, kind, status, minutes_expected, created_at, updated_at)
       VALUES (?, ?, ?, 'meeting', 'published', ?, ?, ?)`,
      [`smoke-min-${label}-${stamp}`, `${title} ${label}`, startsAt.toISOString(), expected, new Date().toISOString(), new Date().toISOString()]
    ).lastInsertRowid);
    ids.push(id); return id;
  };
  const mailTo = (u, like) => get('SELECT COUNT(*) AS n FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [u.email, `%${like}%`]).n;
  const at = (start, days, hours = 0) => new Date(start.getTime() + days * 86_400_000 + hours * 3_600_000);
  const stateOf = (id, now) => Minutes.tasks({ now }).find((t) => t.event.id === id)?.state;
  const addDoc = (kind, status, { eventId = null, date = null } = {}) => {
    const ts = new Date().toISOString();
    const id = Number(run(`INSERT INTO documents (kind, title, status, visibility, meeting_date, event_id, created_by, created_at, updated_at, next_version)
      VALUES (?, ?, ?, 'board', ?, ?, ?, ?, ?, 2)`, [kind, `${title} doc`, status, date, eventId, sec.id, ts, ts]).lastInsertRowid);
    run(`INSERT INTO document_versions (document_id, number, original_name, stored_name, mime, size, sha256, created_by, created_at)
      VALUES (?, 1, 'm.pdf', ?, 'application/pdf', 1, 'ab', ?, ?)`, [id, `${stamp}${id}`.padEnd(32, '0').slice(0, 32), sec.id, ts]);
    docs.push(id); return id;
  };

  // The event form carries the setting.
  Users.setBoardRole(admin.id, 'treasurer');
  const form = await req('/members/admin/events/new');
  record(/name="minutes_expected"/.test(form.text), 'the event form has "Minutes are expected"');
  let r = await multipart('/members/admin/events/new', { _csrf: csrfFrom(form.text), title: `${title} Form`, starts_at: '2031-06-12T19:00', kind: 'meeting', status: 'published', minutes_expected: '1' });
  const made = get('SELECT * FROM events WHERE title = ?', [`${title} Form`]);
  if (made) ids.push(made.id);
  record(made?.minutes_expected === 1, 'it is saved with the event', `-> ${r.status}`);
  record(/id="minutes_expected"[^>]*checked/.test((await req(`/members/admin/events/${made.id}/edit`)).text), 'and shown ticked when editing');

  // The timeline for one meeting.
  const start = zonedToUtc(2031, 5, 8, 19, 0);
  const e1 = addEvent('one', start);
  const e0 = addEvent('none', start, 0);
  record(stateOf(e1, at(start, -1)) === undefined, 'nothing is followed before the meeting has happened');
  record(stateOf(e0, at(start, 5)) === undefined, 'a meeting without "minutes expected" is never followed');
  const dayAfter = at(start, 0, 6); // 1 AM next day, local
  record(stateOf(e1, dayAfter) === 'missing', 'afterwards the minutes are marked as needed');
  let t = todosFor(Users.findById(sec.id), { now: dayAfter });
  record(t.some((x) => x.title === `Write the minutes for ${title} one`) && !t.find((x) => x.title.includes(`${title} one`)).secondary === false, 'the Secretary has a to-do the next morning, with a Not needed button');
  record(!todosFor(Users.findById(vp.id), { now: dayAfter }).some((x) => x.title.includes(`${title} one`)), 'and nobody else does yet');
  await Minutes.runMinutes({ now: dayAfter });
  record(mailTo(sec, 'Minutes needed') === 0, 'no email yet');
  const d3 = Minutes.tasks({ now: at(start, 5) }).find((x) => x.event.id === e1).nudgeFrom;
  await Minutes.runMinutes({ now: new Date(d3.getTime() + 3600_000) });
  record(mailTo(sec, 'Minutes needed') === 1 && mailTo(pres, 'Minutes needed') === 0, 'three days on, the Secretary is emailed (and only the Secretary)');
  const nudge = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [sec.email, `%Minutes needed: ${title} one%`]);
  record(/<table/.test(nudge.body_html ?? '') && /board\/new\?kind=minutes&event=/.test(nudge.body_text), 'it is a styled email that opens the add-minutes form for that meeting');
  await Minutes.runMinutes({ now: new Date(d3.getTime() + 2 * 3600_000) });
  await Minutes.runMinutes({ now: new Date(d3.getTime() + 25 * 3600_000) });
  record(mailTo(sec, 'Minutes needed') === 1, 'not again the same day or the next');
  await Minutes.runMinutes({ now: new Date(d3.getTime() + 2 * 86_400_000 + 3600_000) });
  record(mailTo(sec, 'Minutes needed') === 2, 'but every two days');
  const d10 = Minutes.tasks({ now: at(start, 20) }).find((x) => x.event.id === e1).escalateFrom;
  await Minutes.runMinutes({ now: new Date(d10.getTime() - 3600_000) });
  record(mailTo(pres, 'Minutes overdue') === 0, 'the President is not told early');
  await Minutes.runMinutes({ now: new Date(d10.getTime() + 3600_000) });
  record(mailTo(pres, 'Minutes overdue') === 1 && mailTo(vp, 'Minutes overdue') === 1, 'at ten days the President and Vice President are told');
  await Minutes.runMinutes({ now: new Date(d10.getTime() + 2 * 86_400_000) });
  record(mailTo(pres, 'Minutes overdue') === 1, 'only once');
  record(todosFor(Users.findById(pres.id), { now: new Date(d10.getTime() + 3600_000) }).some((x) => x.title === `Minutes overdue: ${title} one`), 'and it shows on their dashboard');

  // With no Secretary, the President is the one reminded.
  Users.setBoardRole(sec.id, null);
  const e2 = addEvent('two', start);
  const d3b = Minutes.tasks({ now: at(start, 5) }).find((x) => x.event.id === e2).nudgeFrom;
  await Minutes.runMinutes({ now: new Date(d3b.getTime() + 3600_000) });
  record(mailTo(pres, `Minutes needed: ${title} two`) === 1 && Minutes.isOwner(Users.findById(pres.id)), 'with no Secretary the President is reminded instead');
  Users.setBoardRole(sec.id, 'secretary');

  // Minutes arriving stops it. Linked to the meeting, or dated the day of it.
  const e3 = addEvent('three', start);
  const doc3 = addDoc('minutes', 'draft', { eventId: e3 });
  record(stateOf(e3, at(start, 4)) === 'draft', 'minutes linked to a meeting count as in');
  const start4 = zonedToUtc(2031, 5, 15, 19, 0);
  const e4 = addEvent('four', start4);
  addDoc('minutes', 'in_review', { date: '2031-05-15' });
  record(stateOf(e4, at(start4, 4)) === 'in_review', 'so do minutes dated the day of the meeting');
  const before = mailTo(sec, 'Minutes needed');
  await Minutes.runMinutes({ now: at(start, 4, 12) });
  record(mailTo(sec, `Minutes needed: ${title} three`) === 0 && mailTo(sec, `Minutes needed: ${title} four`) === 0 && !todosFor(Users.findById(sec.id), { now: at(start, 4) }).some((x) => /three|four/.test(x.title)), 'and then nobody is nudged and the to-do is gone');

  // The add form.
  Users.setBoardRole(admin.id, 'secretary');
  const e5 = addEvent('five', new Date(Date.now() - 2 * 86_400_000));
  const pre = await req(`/members/documents/board/new?kind=minutes&event=${e5}`);
  record(new RegExp(`<option value="${e5}" selected>`).test(pre.text) && pre.text.includes(`Meeting minutes, ${title} five`), 'the add form opens ready for that meeting');
  const pdf = Buffer.from(`%PDF-1.4\n% ${stamp}\n%%EOF\n`);
  r = await multipart('/members/documents/board', { _csrf: csrfFrom((await req(`/members/documents/board/new?kind=minutes&event=${e5}`)).text), kind: 'minutes', title: `${title} Linked`, event_id: String(e5), file: { blob: new Blob([pdf]), name: 'minutes.pdf' } });
  const linked = get('SELECT * FROM documents WHERE title = ?', [`${title} Linked`]);
  if (linked) { docs.push(linked.id); }
  record(linked?.event_id === e5 && Boolean(linked.meeting_date), 'saving it links the minutes to the meeting and fills in the date', `-> ${r.status}`);

  // Not needed.
  const e6 = addEvent('six', start);
  run("UPDATE users SET role = 'member' WHERE id = ?", [admin.id]);
  Users.setBoardRole(admin.id, null);
  const tok = csrfFrom((await req('/members')).text);
  r = await req(`/members/documents/minutes/${e6}/not-needed`, { method: 'POST', body: { _csrf: tok } });
  record(r.status === 403 && stateOf(e6, at(start, 4)) === 'missing', 'an ordinary member cannot say minutes are not needed', `-> ${r.status}`);
  Users.setBoardRole(admin.id, 'secretary');
  r = await req(`/members/documents/minutes/${e6}/not-needed`, { method: 'POST', body: { _csrf: tok } });
  record(stateOf(e6, at(start, 4)) === 'not_needed' && !todosFor(Users.findById(sec.id), { now: at(start, 4) }).some((x) => x.title.endsWith('six')), 'an officer can; the to-do goes');
  const nb = mailTo(sec, `Minutes needed: ${title} six`);
  await Minutes.runMinutes({ now: at(start, 6) });
  record(mailTo(sec, `Minutes needed: ${title} six`) === nb, 'and the reminders stop');
  const bp = await req('/members/documents/board');
  record(/Meeting minutes/.test(bp.text) && bp.text.includes(`${title} five`), 'the board page lists meetings and where their minutes stand');
  r = await req(`/members/documents/minutes/${e6}/reopen`, { method: 'POST', body: { _csrf: csrfFrom(bp.text) } });
  record(stateOf(e6, at(start, 4)) === 'missing', 'and it can be reopened');

  // Publishing minutes tells members, with a link only.
  const pub = addDoc('minutes', 'approved', { eventId: e1 });
  const pubPage = await req(`/members/documents/${pub}`);
  record(/name="notify"[^>]*checked/.test(pubPage.text), 'publishing minutes offers to email members, ticked the first time');
  r = await req(`/members/documents/${pub}/publish`, { method: 'POST', body: { _csrf: csrfFrom(pubPage.text), notify: '1' } });
  const sentMail = get('SELECT * FROM email_outbox WHERE to_addr = ? AND subject LIKE ?', [ma.email, `Minutes available: ${title} doc%`]);
  record(Boolean(sentMail) && /<table/.test(sentMail.body_html) && /\/members\/documents\/\d+/.test(sentMail.body_text) && !/pdf/i.test(sentMail.body_html.replace(/documents/g, '')) && /\/unsubscribe\//.test(sentMail.body_html), 'members get a styled email with a link, not the file, and an unsubscribe link');
  record(mailTo(mb, 'Minutes available') === 0, 'a member who turned meeting notices off does not');
  record(/emailed members a link/.test((await req(`/members/documents/${pub}`)).text), 'the document history records it');
  const other = addDoc('agenda', 'approved');
  const op = await req(`/members/documents/${other}`);
  r = await req(`/members/documents/${other}/publish`, { method: 'POST', body: { _csrf: csrfFrom(op.text), notify: '1' } });
  record(mailTo(ma, 'Minutes available') === 1, 'publishing something that is not minutes emails no one');
  const pub2 = addDoc('minutes', 'approved');
  const p2 = await req(`/members/documents/${pub2}`);
  await req(`/members/documents/${pub2}/publish`, { method: 'POST', body: { _csrf: csrfFrom(p2.text) } });
  record(mailTo(ma, 'Minutes available') === 1, 'with the box unticked, nothing is sent');

  // Paused: nothing.
  Users.setBoardRole(sec.id, 'secretary');
  const e7 = addEvent('seven', start);
  Scheduler.setPaused(true);
  const dd = Minutes.tasks({ now: at(start, 5) }).find((x) => x.event.id === e7).nudgeFrom;
  await Scheduler.tick({ now: new Date(dd.getTime() + 3600_000) });
  record(mailTo(sec, `Minutes needed: ${title} seven`) === 0, 'while paused no reminder goes out');
  Scheduler.setPaused(false);
  await Scheduler.tick({ now: new Date(dd.getTime() + 3600_000) });
  record(mailTo(sec, `Minutes needed: ${title} seven`) === 1, 'the scheduler tick also runs the minutes follow-up');

  for (const id of docs) run('DELETE FROM documents WHERE id = ?', [id]);
  for (const id of ids) {
    run('DELETE FROM minutes_tasks WHERE event_id = ?', [id]);
    run('DELETE FROM scheduled_sends WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM notices WHERE occurrence_key LIKE ?', [`event:${id}:%`]);
    run('DELETE FROM events WHERE id = ?', [id]);
  }
  run('DELETE FROM email_outbox WHERE subject LIKE ?', [`%${title}%`]);
  for (const u of [sec, pres, vp, ma, mb]) {
    run('DELETE FROM email_outbox WHERE to_addr = ?', [u.email]);
    run('DELETE FROM users WHERE id = ?', [u.id]);
  }
  Scheduler.setPaused(wasPaused);
  console.log = realLog;
  run('UPDATE users SET role = ? WHERE id = ?', [oldRole, admin.id]);
  Users.setBoardRole(admin.id, oldOffice);
  for (const [office, u] of held) if (u && Users.findById(u.id) && !Users.findById(u.id).board_role) Users.setBoardRole(u.id, office);
}

console.log('\nChapter time');
{
  // Event times are typed in chapter (Eastern) time and must not depend on the
  // server's own zone. Fly runs in UTC; a developer's machine usually does
  // not, which is how 7 PM once became 3 PM on the live site unnoticed. So
  // force UTC here, whatever zone this suite runs in.
  const saved = process.env.TZ;
  process.env.TZ = 'UTC';
  const winter = parseLocal('2026-12-10T19:00')?.toISOString();
  const summer = parseLocal('2026-07-04T19:00')?.toISOString();
  record(winter === '2026-12-11T00:00:00.000Z', '7 PM in December is stored as 7 PM Eastern', `-> ${winter}`);
  record(summer === '2026-07-04T23:00:00.000Z', '7 PM in July is stored as 7 PM Eastern', `-> ${summer}`);
  record(toLocalInput(winter) === '2026-12-10T19:00', 'the edit form shows the time that was typed', `-> ${toLocalInput(winter)}`);
  record(
    toLocalDateInput(parseLocal('2026-12-11')?.toISOString()) === '2026-12-11',
    'a date-only field keeps its day',
    `-> ${toLocalDateInput(parseLocal('2026-12-11')?.toISOString())}`
  );
  record(parseLocal('2026-02-30') === null, 'an impossible date is rejected');
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
}

console.log('\nCleanup');
{
  const { text } = await req('/members/builds');
  const id = text.match(/\/members\/builds\/(\d+)\/edit/)?.[1];
  if (id) {
    const form = await req(`/members/builds/${id}/edit`);
    const gone = await req(`/members/builds/${id}/delete`, { method: 'POST', body: { _csrf: csrfFrom(form.text) } });
    record(gone.status === 302, 'delete the test build', `→ ${gone.status}`);
  } else {
    record(false, 'find the test build to delete');
  }

  const locker = await req('/members/locker?q=Smoke%20Test%20Wrench');
  const toolId = locker.text.match(/href="[^"]*\/members\/locker\/(\d+)"/)?.[1];
  if (toolId) {
    const form = await req(`/members/locker/${toolId}/edit`);
    const gone = await req(`/members/locker/${toolId}/delete`, { method: 'POST', body: { _csrf: csrfFrom(form.text) } });
    record(gone.status === 302, 'delete the test tool', `→ ${gone.status}`);
  } else {
    record(false, 'find the test tool to delete');
  }

  // Fetch twice: the first response still carries the "removed" flash message,
  // which mentions the tool by name and would false-positive this check.
  await req('/members/locker');
  const check = await req('/members/locker');
  record(!check.text.includes('Smoke Test Wrench'), 'no test records left behind');
}

/* ------------------------------------------------------------- logout */
console.log('\nSign out');
{
  const { text } = await req('/members/account');
  const out = await req('/logout', { method: 'POST', body: { _csrf: csrfFrom(text) } });
  record(out.status === 302, 'sign out', `→ ${out.status}`);
  const after = await req('/members');
  record(after.status === 302, 'members area gated again after sign out', `→ ${after.status}`);
}

/*
 * Remove the suite's administrator, so it does not sit in the members directory
 * or the admin list looking like a real person. Done last, after sign-out, and
 * directly rather than through the UI: the site deliberately makes deleting a
 * member a considered act, and this is not one. Foreign keys cascade, so
 * anything the run created and missed goes with it.
 */
{
  const me = Users.findByEmail(EMAIL);
  if (me) run('DELETE FROM users WHERE id = ?', [me.id]);
  record(!Users.findByEmail(EMAIL), 'the suite removed its own test account');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
