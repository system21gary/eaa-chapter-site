# EAA Chapter 1699 — chapter website

A Node.js website for [EAA Chapter 1699](https://chapters.eaa.org/eaa1699) at
**South Albany Airport (4B0)**, Selkirk, New York.

Public pages introduce the chapter and its events. Behind a login, the
**Members Corner** carries a CMS-backed blog and a **Tool Locker** where members
list tools they are willing to lend. A **Members' Builds** section is public, so
the chapter's actual work is the front door.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional in development
npm run seed              # demo content + a link to set the admin password
npm run dev               # http://localhost:3000
```

`npm run seed` prints a one-time link. Open it to set the administrator
password — there is no default password anywhere in this project, by design.

```bash
node scripts/smoke.mjs          # 94 HTTP-level checks against a running server
node scripts/members-audit.mjs  # 52 browser checks: every members form, with uploads
npm run reset                   # wipe the database and uploads (development only)
```

`smoke.mjs` speaks HTTP. `members-audit.mjs` drives a real browser through every
create / edit / cancel / delete path in the Members Corner, uploads real images
and checks they render afterwards — it catches the things that only break once a
browser is involved (multipart encoding, client-side form handling, links that
go nowhere under a path prefix). It needs a Chrome binary:

```bash
CHROME_PATH=/path/to/chrome PUPPETEER_ROOT=/path/with/puppeteer-core \
  node scripts/members-audit.mjs
```

Run both against **both** configurations — at a domain root and with `BASE_PATH`
set. Several classes of bug only appear under a prefix.

---

## The stack

| | |
|---|---|
| Runtime | Node.js 23.4+ (uses the built-in `node:sqlite`, unflagged from 23.4) |
| Web | Express 4, server-rendered Nunjucks |
| Database | SQLite (WAL), plain SQL with bound parameters |
| Images | sharp — every upload decoded and re-encoded to WebP |
| Sessions | `express-session` on a SQLite store |
| Passwords | scrypt from `node:crypto` |

No build step, no client-side framework, no CDN. The whole site is one process
and one file on disk, which is the right size for a volunteer-run chapter.
Everything works without JavaScript; the JS that exists adds carousels, image
previews and a mobile menu.

---

## What is here

### Public

| Route | |
|---|---|
| `/` | Welcome / who we are |
| `/about` | The chapter in depth — counsellors, Young Eagles, Ray Scholarship |
| `/events` | Upcoming events |
| `/events/past` | Archive with photo galleries and write-ups |
| `/events/:slug` | Event detail with directions and contact |
| `/events/calendar.ics` | Subscribable feed (ForeFlight, Google, Outlook, Apple) |
| `/builds` | **Members' builds** — every public project |
| `/builds/:slug` | One project: spec panel, progress bar, dated build log |
| `/contact` | Contact form |
| `/join` | Request a members account — reviewed by an admin |

### Members Corner (`/members`, authenticated)

- **Dashboard** — pending borrow requests, latest posts, your tools, next events
- **Blog** — markdown CMS with drafts, tags, pinning, revision history,
  per-post `members` / `public` visibility, and plain-text comments
- **Tool Locker** — listings with image carousels, category and availability
  filters, location, lending terms, and a full borrow-request workflow
  (request → approve/decline → mark returned, with availability kept in step)
- **Your Builds** — create projects and post dated log entries with photos and
  hours; a project can be public or members-only
- **Directory** — contact details, shared between members only
- **Account** — profile, avatar, password reset, sign out everywhere

### Editors and admins

- Event management with posters, galleries and after-the-fact recaps
- Contact-form inbox
- **Membership requests** — review queue for the public `/join` form; approving
  creates the account and sends an invitation, declining can optionally notify
  the applicant
- Member management: invitations, roles, suspension
- Activity log and the outbound mail queue

---

## How somebody gets an account

1. They fill in **`/join`** — name, email, and a few sentences about themselves.
2. An **admin reviews it** at `/members/admin/applications`. Nothing exists in
   the members' world until then: an unreviewed request has no user row, so it
   cannot hold a session, appear in the directory, or own anything.
3. On approval the account is created and an **invitation** goes out.
4. The applicant follows that one-time link and **chooses their own password**.

An admin can still invite somebody directly from the People page, which enters
the same flow at step 3.

Because the request form is public, it is built not to leak:

- A request for an address that **already has an account** is silently dropped —
  it never reaches the review queue, so the form cannot be used to spam an
  admin's inbox or to test who is already a member.
- A **second request** for an address with one still pending is refused by a
  partial unique index, and the exception is swallowed.
- All three cases — new request, duplicate, existing member — produce the
  **identical response**, so nothing about which applied is observable.
- Honeypot field, submission-time trap, and the hourly rate limit apply.

---

## Roles

| Role | Can |
|---|---|
| `member` | Tool Locker, build logs, blog reading and comments, directory |
| `editor` | …plus writing blog posts and running the events calendar |
| `admin` | …plus inviting people, changing roles, and reading the activity log |

The last remaining administrator cannot be demoted or suspended, so the chapter
cannot lock itself out.

---

## Security

The brief was to resist injection and the usual attacks. What that means here:

### Passwords are never stored

`users.password_hash` holds a **scrypt** digest — `scrypt$N$r$p$salt$digest`,
memory-hard, per-user random salt, with an optional server-side pepper from the
environment. There is no operation anywhere in the codebase that turns a stored
value back into a password, which is exactly why **the only recovery path is a
reset link**.

Consequences, all deliberate:

- Accounts are created with `password_hash` **NULL**. An administrator inviting
  a member — or approving a request from `/join` — never chooses a password for
  them, and never sees one.
- The seed script cannot create a password either. It prints a reset link.
- Even a signed-in member changing their own password goes through the email
  link, so a hijacked session alone cannot silently take over an account.
- Reset tokens are stored as a **SHA-256 digest**, single-use, one-hour expiry,
  and a new request invalidates any outstanding one.
- Completing a reset **revokes every existing session** for that account.
- Strength is checked NIST-style: length first, a common-password list,
  and rejection of passwords built from the member's own name or email.
  Optional Have I Been Pwned k-anonymity check (`PWNED_CHECK=1`) — only the
  first five characters of the SHA-1 ever leave the server.

### Writing content

Long-form fields — blog posts, tool descriptions, build write-ups, log entries,
event details — use a **rich text editor** ([Trix](https://trix-editor.org),
MIT, vendored into `public/vendor/`, no CDN). Bold, italic, headings, quotes,
lists, links and code, with the usual keyboard shortcuts.

What is *stored* is still markdown. The editor's HTML is sanitised against an
allow-list and converted back with [Turndown](https://github.com/mixmark-io/turndown),
so content stays readable without this application, survives swapping the
editor out, and diffs sensibly in the blog's revision history.

The editor is progressive enhancement: the server renders a plain textarea
holding markdown, and JavaScript upgrades it. With JavaScript off the textarea
is what submits, and a hidden `<field>_format` tells the server which of the
two it is getting rather than guessing.

Sanitising happens **before** conversion. The HTML arriving from that field is
untrusted — anyone can post whatever they like to it — so `<script>`, event
handlers and `javascript:` URLs are stripped before Turndown ever sees them,
and therefore cannot reach the stored markdown.

### Injection

- **SQL** — every statement is prepared with bound parameters. There is no
  string interpolation of user input into SQL anywhere. `LIKE` searches escape
  `%` and `_` in the user's text.
- **XSS** — Nunjucks autoescapes by default. Member markdown is rendered and
  then run through a `sanitize-html` **allow-list**, so `<script>`, `<iframe>`,
  `on*` attributes and `javascript:` / `data:` URLs cannot survive. Comments
  are stored and rendered as plain text and never parsed as markup.
- **CSP** — a per-request nonce; no `unsafe-inline` for scripts, `script-src-attr
  'none'`, `object-src 'none'`, `frame-ancestors 'none'`. Even if a sanitiser
  were bypassed, injected script is inert.
- **Mass assignment** — every form goes through an allow-list validator that
  drops unnamed fields. `owner_id`, `role` and `status` always come from the
  session or an explicit admin action, never from a submitted field.

### Sessions and CSRF

- Session id only in an `httpOnly`, `SameSite=Lax`, `Secure`-in-production
  cookie; all state server-side, so a session can be revoked instantly.
- Session **regenerated on login** — session fixation dies at the door.
- Signed **double-submit CSRF tokens** HMAC-bound to the session id (replacing
  the deprecated `csurf`), plus an `Origin`/`Referer` check on every unsafe
  method.
- File uploads arrive as `multipart/form-data`, which `express.urlencoded` does
  not parse — the token is only readable after the route's own multer has run.
  Those requests are marked and verified by `verifyMultipartCsrf` immediately
  after multer; `auditDeferredCsrf` logs loudly if a route with uploads ever
  completes without that check, so a missing one surfaces in testing.
- Role and status are re-read from the database on every request, so a
  suspension or demotion takes effect immediately.

### Uploads

Uploads are treated as hostile. Files are buffered **in memory** and never
written under a client-supplied name. The **magic bytes** are checked, not the
extension or `Content-Type`. Everything is then fully **decoded and re-encoded
by sharp**, which discards EXIF (including the GPS tag your phone puts on a
photo of your hangar), any appended payload, and polyglot files. Decompression
bombs are capped at 50 MP. Results are stored **outside the web root** under a
random name and served by a route that pins `Content-Type: image/webp` and
refuses anything else. Tool and avatar images require a session.

### Rate limiting and enumeration

- Login is limited per **IP *and* submitted email**, with a per-account lockout
  on top. IPv6 is collapsed to its `/64` so one attacker cannot walk a subnet.
- Login failures are **identical** for a wrong password, an unknown address and
  an account with no password — and the unknown-address path burns the same CPU
  on a decoy hash, so response timing does not leak either.
- "Forgot password" always reports the same outcome whether or not the address
  exists.
- Separate limits on password reset, the contact form, uploads and writes.

### Other

- Helmet: HSTS, `nosniff`, `frame-deny`, strict referrer policy, restrictive
  Permissions-Policy. `/members/*` responses are `no-store`.
- Contact form uses a honeypot plus a time trap, and both fail *silently* so a
  bot cannot tune against the response.
- Errors in production return a friendly sentence — no stack traces, no SQL,
  no paths.
- An append-only audit log records logins, resets, role changes and content
  edits. Client IPs are stored only as a keyed HMAC digest.
- Redirects after login are restricted to same-site paths; nothing echoes a
  `Referer` back as a redirect target.

---

## Deploying

The site runs on **Fly.io**; see **[DEPLOY.md](DEPLOY.md)** for setup, backups
and restoring. The short version:

- The database and uploaded photos live on a **Fly volume** mounted at `/data`.
  A machine's own disk is rebuilt on every deploy, which is why data used to
  vanish.
- **Litestream** streams every database change to a Tigris bucket within about
  a second, keeping 30 days of history. Fly snapshots the volume, photos
  included, daily.
- If the volume is lost, `scripts/start.sh` restores the database from the
  bucket on the next boot.
- Each morning the site restores the backup into a scratch file, checks it, and
  emails the administrators a report (`npm run backup:report` runs it now).

Keep it to **one machine**: SQLite lives on one volume attached to one machine.

`Dockerfile` pins Node 24 deliberately: buildpacks resolve the lowest version
satisfying `engines`, and the built-in SQLite needs 23.4+.

---

## Configuration

See `.env.example`. In production `SESSION_SECRET` and `CSRF_SECRET` are
**required** and must be at least 32 characters — the app refuses to start
otherwise rather than falling back to a guessable default.

Set `TRUST_PROXY=1` only when actually behind a reverse proxy you control;
trusting forwarded headers otherwise lets a client spoof its IP and walk past
the rate limits.

### Running under a path prefix

The site assumes it owns a domain root. If a proxy exposes it under a path
instead — a Coder or code-server port proxy, Gitpod, or shared hosting — set
`BASE_PATH` to that path:

```bash
BASE_PATH=/tasks/abc123/vscode/proxy/3000 npm run dev
```

Every generated URL is then prefixed, and the prefix is stripped from incoming
requests, so the same build works both ways. It also handles proxies that
strip the prefix themselves (code-server's `/proxy/<port>/`) and those that
pass it through (`/absproxy/<port>/`).

**The symptom of getting this wrong is an unstyled page**: the HTML arrives
fine, but `/assets/css/site.css` resolves against the domain root and 404s.
`scripts/smoke.mjs` asserts that asset and navigation URLs carry whatever
prefix is configured.

The prefix is never read from a request header. Trusting something like
`X-Forwarded-Prefix` would let any client rewrite every link on the page, and
a deployment already knows its own path.

Two things that go with it:

- **Set `BASE_URL` to the public origin.** The origin check on form submissions
  compares the browser's `Origin` against the host the request arrived on;
  behind a proxy those differ, and every POST is refused with *"Cross-origin
  form submissions are not accepted."* `BASE_URL` declares the real origin
  (add more in `ALLOWED_ORIGINS`, comma separated). Anything undeclared is
  still refused.
- **Set `SESSION_SECRET` and `CSRF_SECRET`.** Without them a random secret is
  generated at startup, so every restart silently invalidates open sessions and
  the next form submission fails with *"This form expired or came from an
  untrusted source."* Fine to discover in development, miserable to debug.

The session cookie stays scoped to `/`, not to `BASE_PATH`. `express-session`
skips any request whose pathname does not start with the cookie's path, and a
prefix-stripping proxy means the app sees `/reset/x` while the browser sees
`/prefix/reset/x`. Scoping to the prefix gives no session, no CSRF token, and a
403 on every form.

### Email

`MAIL_TRANSPORT=outbox` (the default) queues mail in the database and prints it
to the console, delivering nothing. That is how a fresh install bootstraps: you
read the first invitation link straight out of the queue, without the site ever
emailing a password. `MAIL_TRANSPORT=smtp` plus `SMTP_HOST` / `SMTP_USER` /
`SMTP_PASS` delivers for real — and the app refuses to start if you ask for
`smtp` without them, because silently queueing mail nobody receives is the
failure this is here to prevent.

Verify it with `npm run mail:check -- you@example.com`, which uses the same
config and transport as the site and prints no credential values.

Either way, nothing is sent inside the request that asked for it. Messages are
written to `email_outbox` and delivered by a background worker, with retries at
1, 5, 15, 60 and 240 minutes. Two reasons: a relay hiccup must not fail an
action that already succeeded, and `/forgot` deliberately answers identically
for a registered and an unregistered address — sending in-request would break
that, because only a registered address attempts delivery and so only it can
fail. Failures land in the activity log with a **Retry now** button.

Delivery claims each row before sending, so the background worker and a manual
`npm run mail:check -- --drain` cannot both deliver the same message.

Two guards keep the demo content from emailing people who do not exist:
addresses at the RFC 2606 documentation domains (`example.com` and friends) are
never attempted, and `scripts/smoke.mjs` refuses to run against a live mail
configuration unless passed `--allow-live-mail`, since it triggers a password
reset and submits the contact form on every run.

See **DEPLOY.md** for provider settings and the SPF/DKIM/DMARC records.

---

## Layout

```
server.js                  entry point, mail worker, backup report, shutdown
litestream.yml             continuous database backup (Litestream)
fly.toml                   Fly.io app: volume, environment, deploy
scripts/start.sh           container entry point: volume permissions,
                           restore-on-boot, rollback swap, runs Litestream
scripts/smoke.mjs          end-to-end test suite
scripts/mail-check.mjs     SMTP connection check and test send
scripts/backup-report.mjs  run the backup check now; --send to email it
src/
  app.js                   middleware pipeline and route mounting
  config.js                environment, with production guards
  db/
    migrate.js             append-only versioned migrations
    seed.js                demo content
    placeholder-art.js     generated SVG imagery for the demo
  lib/                     passwords, tokens, csrf, sessions, images,
                           markdown, validation, mail, audit
  middleware/              security headers, rate limits, auth, errors
  models/                  users, posts, tools, events, builds
  routes/                  public, auth, members, blog, locker, builds, admin
  views/                   Nunjucks templates + filters
public/                    css, js, images  (served under /assets)
data/                      SQLite file and uploads  (gitignored)
```

---

## Demo content

`npm run seed` creates eight fictional members, ten tools with photos, five
build logs with dated entries, nine events, six blog posts, a couple of borrow
requests in flight, and three membership requests waiting in the review queue.
Imagery is generated locally as SVG — no stock photos, no licensing, and
deterministic from a seed string.

The one piece of real data is the **May 2026 pancake breakfast**, taken from the
chapter's public AOPA listing, along with its cartoon poster.

Seeded members have **no password**, so nobody can sign in as them. Use
*Re-invite* on the People page to exercise the invitation flow.
