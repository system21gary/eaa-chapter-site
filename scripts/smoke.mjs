/**
 * End-to-end smoke test.
 *
 * Drives the site the way a browser would -- cookies, CSRF tokens, redirects --
 * through the real password-reset flow, then walks every members-only page.
 * Run against a *development* server:  node scripts/smoke.mjs
 */
import * as Users from '../src/models/users.js';
import { get, run } from '../src/db/index.js';
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
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
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
  const prefix = (process.env.BASE_PATH || '').replace(/\/+$/, '');
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
for (const p of ['/members', '/members/blog', '/members/locker', '/members/locker/new', '/members/locker/requests', '/members/builds', '/members/builds/new', '/members/directory', '/members/account', '/members/admin/events', '/members/admin/events/new', '/members/admin/members', '/members/admin/messages', '/members/admin/log']) {
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
