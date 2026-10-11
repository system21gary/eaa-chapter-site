# EAA Chapter 1699 website — runbook

Everything known about this site as of October 2026: what it is, where it runs,
how it is looked after, what has gone wrong and why, and what is still open.
Written to hand over to whoever (or whichever agent) picks the project up next.
[README.md](README.md) covers the application in depth and
[DEPLOY.md](DEPLOY.md) the deployment procedures; this document ties them
together and records the history behind them.

**Nothing secret is in this repository, and nothing secret should ever be.**
Real values live in Fly secrets (live site) and in a git-ignored `.env`
(development). See [Secrets](#secrets).

**Which shell.** Commands to run on your own Windows machine are
**PowerShell** (`powershell` blocks). Commands typed at the server's prompt,
after `fly ssh console`, run on the Linux server in `sh`, whatever you
connected from; those blocks are marked *at the server's prompt*. A few
blocks for a Linux development container (CoderFlow) are marked `bash`. The
PowerShell commands here were tested in PowerShell 7.

---

## Contents

1. [At a glance](#at-a-glance)
2. [The chapter and the airport](#the-chapter-and-the-airport)
3. [People and roles](#people-and-roles)
4. [The application](#the-application)
5. [Where it runs: Fly.io](#where-it-runs-flyio)
6. [Secrets](#secrets)
7. [Email](#email)
8. [Data, backups and restoring](#data-backups-and-restoring)
9. [Everyday operations](#everyday-operations)
10. [Developing and testing](#developing-and-testing)
11. [Working in CoderFlow](#working-in-coderflow)
12. [Lessons learned](#lessons-learned)
13. [Current state and open items](#current-state-and-open-items)
14. [History](#history)

---

## At a glance

| | |
|---|---|
| What | Website for EAA Chapter 1699: public pages, events, members' builds, and a members-only area with a blog, Tool Locker and directory |
| Live URL | https://eaa-chapter-site-lfhcfw.fly.dev |
| Repository | https://github.com/system21gary/eaa-chapter-site (public), branch `main` |
| Host | Fly.io, app `eaa-chapter-site-lfhcfw`, region `iad`, one machine, 512 MB, volume `eaa_data` at `/data` |
| Stack | Node.js 24 (needs 23.4+), Express 4, Nunjucks, built-in `node:sqlite`; no build step, no client framework, nothing from a CDN |
| Database | One SQLite file, `/data/eaa1699.sqlite` |
| Backups | Litestream to a Tigris bucket (continuous, 30 days) plus daily Fly volume snapshots (30 days) |
| Email | Outbound over SMTP through an IONOS mailbox; queued, with retries |
| Owner | Gary Jones, chapter member and site administrator; built at the suggestion of chapter president Ted Simons |
| Time zone | Everything shown and typed is America/New_York, whatever the server's own zone |

---

## The chapter and the airport

- **EAA Chapter 1699**, South Albany Airport (**4B0**), 6 Old School Road,
  Selkirk, NY 12158. 501(c)(3), EIN 99-1529453 (shown in the footer). Contact
  address used by the site: `info@eaa1699.org` (`CONTACT_EMAIL`).
- Chapter president: **Ted Simons**. The site came out of a conversation
  between Gary and Ted. Gary is a member helping to build and publish it; it is
  not a commercial product and should not read like one.
- A recent fly-in pancake breakfast was listed on AOPA
  (https://www.aopa.org/destinations/event/1817). Its flyer art is in
  `public/img/pancake-breakfast-2026.*` and is used on the home page.
- **4B0 facts** (FAA data via AirNav and SkyVector, October 2026). The site once
  wrongly called 4B0 a grass field; these are the corrected facts:
  - One **paved** runway, **01/19, 2,853 × 60 ft asphalt**, good condition,
    low-intensity edge lights.
  - CTAF/UNICOM **122.9**; **left** traffic for both 01 and 19.
  - Fuel: **100LL and Jet A**, self-serve. (Prices change; the site does not
    show them.)
  - Elevation about 196 ft. Privately owned (South Albany Airport Corp.).
  - Remarks: birds on and around the field; railroad crossing 200 ft south of
    runway 1; closed to aircraft over 12,500 lb; helicopter noise abatement.
  - The runway and fuel lines on the site come from `config.site.airport` in
    `src/config.js`.

---

## People and roles

Roles, from least to most: **member** (Tool Locker, build logs, blog reading
and comments, directory), **editor** (also writes blog posts and runs the
events calendar), **admin** (also people, roles, requests and the activity
log). The last active admin cannot be demoted, suspended or removed.

- **Administrator:** Gary Jones, `gary.jones@hawthorncs.com` (the seed admin,
  `SEED_ADMIN_EMAIL`). Gary also has a second admin account under his Profound
  Logic address, created while testing invitations.
- Accounts are **requested and approved**: anyone can ask at `/join`; an admin
  approves under Members Corner → Requests, which sends an invitation. Admins
  can also invite directly from the Members page.
- **Passwords are never chosen by an admin and never stored.** Accounts are
  created without one; the invitation or reset link lets the person set it.
  Only a scrypt hash is kept.
- Members can be **edited** (name, email, phone, EAA number) and **removed**
  from Members → Edit. See [Everyday operations](#everyday-operations).
- The live database still holds the **demo members** from the seed
  (fictional people at `example.org` addresses) alongside real ones. See
  [open items](#current-state-and-open-items).

---

## The application

### What it does

**Public:** home (welcome / who we are), About, Upcoming events, Past events
(with recaps and photos), event pages, a subscribable calendar
(`/events/calendar.ics`), Members' Builds (a page per aircraft project with a
build log), Contact form, Join (account request), sitemap and robots.

**Members Corner** (`/members`, signed in): dashboard; **blog** (rich-text
editor, revisions, comments); **Tool Locker** (members list tools with photo
carousels and a location; others ask to borrow, the owner approves or declines
by email and on the requests page; nobody's email is shown to anybody);
**Your Builds** (create a build and post log entries with photos); member
**directory** with contact details masked; account page.

**Editors** also write blog posts and run the events calendar.
**Admins** (`/members/admin`): events (create, edit, posters,
photos, recaps), inbox (contact messages), membership requests, people
(roles, suspend, re-invite, edit, remove), activity log (including the mail
queue, with retry).

### How it is built

```
server.js                  entry point: mail worker, backup report, shutdown
src/app.js                 middleware pipeline and route mounting
src/config.js              every setting, with production guards
src/db/                    index.js (connection), migrate.js (versioned
                           migrations 1-7), seed.js (demo content), reset.js
src/lib/                   passwords, tokens, csrf, sessions, images, markdown,
                           richtext, validate, mailer, audit, localtime,
                           backup-report
src/middleware/            security headers, rate limits, auth, base path, errors
src/models/                users, posts, tools, events, builds, applications
src/routes/                public, auth, members, blog, locker, builds,
                           member-builds, media, admin
src/views/                 Nunjucks templates and filters
public/                    css, js, images, vendored Trix editor (served /assets)
scripts/                   start.sh, smoke.mjs, members-audit.mjs,
                           mail-check.mjs, backup-report.mjs, fix-times.mjs,
                           borrow-notify-test.mjs
litestream.yml             continuous backup configuration
fly.toml, Dockerfile       Fly app and image
outreach/                  a short walkthrough brochure for the chapter
                           (HTML + scripts to render a PDF; needs puppeteer)
```

Dependencies: express, express-session, express-rate-limit, helmet,
compression, nunjucks, marked, sanitize-html, turndown, trix (vendored), multer,
sharp, nodemailer, dotenv. Nothing else at runtime; Litestream is a separate
binary in the image.

### Security model, briefly

README.md → Security has the full account. The points that matter when
changing things:

- Passwords: scrypt with per-user salt; optional `PASSWORD_PEPPER` (not set;
  see [Secrets](#secrets)). Reset and invite tokens are stored hashed, single
  use, short-lived; issuing a new reset link voids older ones.
- `/forgot` and `/join` answer identically for known and unknown addresses (no
  account enumeration). That is also why mail is queued, never sent inside a
  request.
- CSRF tokens on every form, plus an Origin check against the request host,
  `BASE_URL` and `ALLOWED_ORIGINS`. **Multipart (upload) forms are verified
  after multer has parsed the body**; a new upload route must call
  `verifyMultipartCsrf` after multer, and a response-time audit catches one
  that forgets.
- Strict CSP: scripts and styles only from the site itself; images from self,
  `data:` and `blob:` (blob is the upload preview).
- Rich text: the editor's HTML is sanitised against an allow-list, then
  converted to markdown for storage; markdown is rendered and sanitised again
  on output.
- Uploads are re-encoded by sharp (metadata stripped, pixel limits against
  decompression bombs) and served through `/media` with path checks.
- Rate limits on login, forms and uploads (skipped in development unless
  `ENFORCE_LIMITS=1`).
- Every significant action goes to the activity log.

### Dates and times

Form inputs send wall-clock text with no zone. `src/lib/localtime.js` reads
it as **chapter time (America/New_York)**, stores an exact UTC instant, and
converts back to chapter time for display and for refilling forms. It is
DST-safe and independent of the server's zone (Fly runs in UTC). The one
setting is `config.site.timeZone`. Never use `new Date("2026-10-15T19:00")`,
`setHours()` or similar server-local calls on user input.

---

## Where it runs: Fly.io

### The app

| Setting | Value |
|---|---|
| App | `eaa-chapter-site-lfhcfw` (org: Gary's) |
| URL | https://eaa-chapter-site-lfhcfw.fly.dev |
| Region | `iad` |
| Machines | **exactly one**; `auto_stop_machines = 'stop'`, `min_machines_running = 1` |
| VM | shared CPU, **512 MB** (256 MB got the seed killed; see lessons) |
| Volume | `eaa_data`, 1 GB, mounted at `/data`; snapshots kept 30 days; auto-extends +1 GB at 80% full up to 5 GB |
| Port | the app listens on 3000 (`PORT` in fly.toml), matching `internal_port` |
| Image | `Dockerfile`: `node:24-slim` + Litestream 0.5.17 copied from its official image; starts `/app/scripts/start.sh` as root, which drops to the `node` user |
| Deploys | built from the GitHub repo by Fly (the dashboard's GitHub integration; deploy logs show Fly's builder). Manual: `fly deploy -a eaa-chapter-site-lfhcfw` |

`fly.toml` `[env]` sets `PORT`, `DATA_DIR=/data`, `TRUST_PROXY=1` and
`BASE_URL`. **Fly secrets override `[env]` of the same name**, which caused the
worst incident so far (see lessons). Those four must not exist as secrets.

There is no `release_command`. Fly runs one on a throwaway machine **without
the volume**, so anything it does to data is lost.

### What start.sh does

1. As root: `chown -R node:node /data`, because a new volume is root-owned and
   because a root shell may have left root-owned files.
2. Drops to `node` with `setpriv`.
3. Builds the Litestream replica URL from `BUCKET_NAME` when a Tigris bucket is
   attached.
4. With arguments (`start.sh npm run seed`): runs that one-off command as
   `node`, with the same settings as the site, and stops.
5. Rollback swap: if `/data/restore.sqlite` exists, moves the live database
   aside (`eaa1699.sqlite.before-restore-<time>`) and puts the restored copy in
   its place.
6. Restores the database from the bucket if the volume has none.
7. Runs the site under `litestream replicate -exec "node server.js"`, or plain
   `node server.js` with a loud warning if no bucket is attached.

### Startup log lines worth knowing

`fly logs -a eaa-chapter-site-lfhcfw` at boot should show:

```
EAA Chapter 1699 — production
Data: /data
Mail: SMTP via smtp.ionos.com:587, worker every 60s (...)
Backup: Litestream to s3://<bucket>/eaa1699.sqlite
Backup report: emailed daily after 6:00 Eastern
```

Warning signs: `development` instead of `production` (a `NODE_ENV` secret);
`Data: /app/data` or a `!!! WARNING ... container's own disk` line (a
`DATA_DIR`/`DB_FILE`/`UPLOAD_DIR` secret); `Backup: NONE` (no bucket);
`Mail: queued to the database only` (`MAIL_TRANSPORT` not `smtp`).

### flyctl from PowerShell

Gary runs `fly` from PowerShell on Windows. Install it with:

```powershell
iwr https://fly.io/install.ps1 -useb | iex
fly auth login
```

Running a command on the server in one go works directly:

```powershell
fly ssh console -a eaa-chapter-site-lfhcfw -C "/app/scripts/start.sh npm run seed"
```

Three things to know:

- **`fly ssh console` logs in as root.** Always prefix commands that touch data
  with `/app/scripts/start.sh`, so they run as the `node` user, as the site
  does. Otherwise they leave root-owned files the site cannot write to.
- **`$` inside double quotes is expanded by PowerShell, on your machine.**
  `-C "... $DATA_DIR ..."` reaches the server with `$DATA_DIR` already replaced
  by nothing. Put such commands in single quotes, or open
  `fly ssh console -a eaa-chapter-site-lfhcfw` and type them at the server's
  prompt. Commands with quotes inside quotes are also easiest at the prompt.
- **Line continuation is a backtick** (`` ` ``) at the very end of the line,
  with nothing after it. One long line works just as well.

(Git Bash, used earlier, rewrites arguments starting with `/` into Windows
paths and needed `MSYS_NO_PATHCONV=1` in front of every such command.
PowerShell does not do this.)

---

## Secrets

### Where they live

| Secret | Where | Notes |
|---|---|---|
| `SESSION_SECRET` | Fly secrets; local `.env` | 32+ chars. Changing it signs everyone out. |
| `CSRF_SECRET` | Fly secrets; local `.env` | 32+ chars. Changing it invalidates open forms (reload fixes it). |
| `SMTP_PASS` | Fly secrets; local `.env` | The IONOS mailbox password. |
| `SMTP_USER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM`, `MAIL_TRANSPORT` | Fly secrets | Not secret as such, but kept together. `MAIL_FROM` must be the `SMTP_USER` mailbox. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME` | Fly secrets | Set by `fly storage create`. Do not edit by hand. |
| `BACKUP_REPORT_TO` | Fly secrets (optional) | Who gets the morning report; default every active admin. |
| `PASSWORD_PEPPER` | **not set** | Do not set it casually: changing or adding it makes every existing password stop working, and everyone would need a reset link. |

`fly secrets list -a eaa-chapter-site-lfhcfw` shows names, never values.

### Secrets that were published, and must be changed

The repository is public. Its history contains real values in two places:
`.env.example` (commit `0381ffb`, since restored to placeholders) and a
committed `.env` (commits `9a66092` to `a354d93`, since deleted). Deleting a
file does not remove it from Git history. These three were published:

- `SESSION_SECRET`
- `CSRF_SECRET`
- `SMTP_PASS` (the IONOS mailbox password)

**Change all three.** Rotating is what makes the leak harmless. Rewriting
history afterwards (e.g. `git filter-repo`, then force-push) is optional
tidiness; copies may already exist elsewhere.

1. Change the mailbox password in the IONOS control panel.

2. In PowerShell, set new session and CSRF secrets and the new mailbox
   password in one go (one restart). `New-Secret` makes 64 random hex
   characters from the operating system's secure random generator:

   ```powershell
   function New-Secret {
     $bytes = [byte[]]::new(32)
     [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
     -join ($bytes | ForEach-Object { $_.ToString('x2') })
   }

   fly secrets set -a eaa-chapter-site-lfhcfw `
     SESSION_SECRET=$(New-Secret) `
     CSRF_SECRET=$(New-Secret) `
     SMTP_PASS='the-new-mailbox-password'
   ```

   Keep the password in **single quotes**: in double quotes PowerShell would
   treat any `$` in it as a variable. If the password itself contains a single
   quote, write it twice (`'it''s'`).

3. Check that mail still works:

   ```powershell
   fly ssh console -a eaa-chapter-site-lfhcfw -C "/app/scripts/start.sh npm run mail:check -- gary.jones@hawthorncs.com"
   ```

Update any development `.env` with the new mailbox password too.

### Secrets that must NOT exist

These are settings, not secrets. As secrets they override `fly.toml` and break
the site. If `fly secrets list` shows any, unset them:

```powershell
fly secrets unset -a eaa-chapter-site-lfhcfw NODE_ENV PORT BASE_URL TRUST_PROXY DATA_DIR DB_FILE UPLOAD_DIR BASE_PATH REDIRECT_MODE ALLOW_OUTBOX_VIEW SMTP_ALLOW_INVALID_CERTS ENFORCE_LIMITS
```

(Only name the ones that are actually listed; flyctl may refuse unknown names.)
`ALLOW_OUTBOX_VIEW=1` in particular lets admins read queued email bodies,
which contain live password-reset links.

---

## Email

- **Transport:** `MAIL_TRANSPORT=smtp` through IONOS (`smtp.ionos.com`, port
  587, STARTTLS required). `MAIL_TRANSPORT=outbox` (the default) queues to the
  database and sends nothing, which is right for development.
- **IONOS rules:** the `From` address must be the authenticated mailbox. Any
  other address gets `550 Sender address is not allowed`. A malformed one gets
  `501 Syntax error`. So `MAIL_FROM='EAA Chapter 1699 <same as SMTP_USER>'`.
  Replies can be steered with `MAIL_REPLY_TO`.
- **Delivery:** nothing is sent inside a web request. Messages are queued in
  `email_outbox`; a worker in the server delivers every 60 s, retrying after
  1, 5, 15, 60 and 240 minutes (six attempts in all), then gives up. Rows are claimed
  atomically, so two drains never double-send. Admins see status and can retry
  in the activity log.
- **Suppressed domains:** mail to `example.com/.org/.net`, `.test`,
  `.invalid` and `localhost` is never attempted (the demo members use these).
  `MAIL_SUPPRESS_DOMAINS` overrides the list.
- **What sends mail:** invitations, password resets, membership requests and
  decisions, contact-form notices to `CONTACT_EMAIL`, borrow requests to the
  tool's owner and decisions back to the borrower, and the morning backup
  report.
- **Check it:** `npm run mail:check` connects and authenticates;
  `npm run mail:check -- you@example.org` also sends a test message;
  `--drain` delivers anything due. It never prints credential values.
- **Deliverability:** SPF, DKIM and DMARC for the sending domain should be in
  place (IONOS provides the DKIM values). Check that the first messages do not
  land in spam.

---

## Data, backups and restoring

### What is stored where

| | Location (live) |
|---|---|
| Database | `/data/eaa1699.sqlite` (+ `-wal`, `-shm`) |
| Uploaded photos | `/data/uploads/` |
| Sessions | in the database (`sessions` table) |

A Fly machine's own disk is rebuilt from the image on every deploy **and every
restart**. Only `/data` survives.

### Backups

1. **Litestream → Tigris.** Every committed change reaches the bucket within
   about a second. History: 30 days (`snapshot.retention: 720h` in
   `litestream.yml`; Litestream's default is only 24 h). Database only.
2. **Fly volume snapshots.** Daily, 30 days (`snapshot_retention` in
   fly.toml). Database and photos. `fly volumes list`, then
   `fly volumes snapshots list <volume id>`.
3. **Morning report.** After 6:00 Eastern the site restores the latest backup
   into a scratch file, runs SQLite's integrity check, confirms it holds every
   change the live site recorded up to two minutes earlier, and emails the
   admins. The subject says **PROBLEM** if the backup is missing, unrestorable
   or behind, or if the data is not on the volume. It also reports counts,
   database size, photo count, volume free space and undelivered mail.
   Run on demand: `/app/scripts/start.sh npm run backup:report -- --send`.
   On in production, off in development (`BACKUP_REPORT=1`/`0` overrides).
   It is claimed in `app_state` first, so a restart never sends it twice.

The database itself is never emailed: it holds every member's contact details
and password hash.

### Restoring

All tested against a local stand-in for the bucket. The volume handover and
`/data` usage are confirmed on Fly; Litestream against the real bucket is not
yet (see open items).

- **Volume or machine lost:** create a volume with the same name and deploy;
  `start.sh` finds no database and restores the latest from the bucket.
- **Roll back to a moment** (something deleted by mistake). Times are UTC:
  10:30 AM Eastern in October is `14:30:00Z`.
  1. Restore that moment to a side file; the site keeps running (PowerShell):
     ```powershell
     fly ssh console -a eaa-chapter-site-lfhcfw -C "/app/scripts/start.sh litestream restore -config /app/litestream.yml -timestamp 2026-10-09T14:30:00Z -o /data/restore.sqlite /data/eaa1699.sqlite"
     ```
  2. Restart; `start.sh` swaps it in before the site opens it:
     ```powershell
     fly apps restart eaa-chapter-site-lfhcfw
     ```
  The replaced database is kept as `eaa1699.sqlite.before-restore-<time>`.
  The backup follows the rollback.
- **Start the database over** (e.g. a half-finished seed). Deleting the file is
  not enough: the site would restore it from the bucket on boot. Use the swap
  with an empty file instead. This uses `$DATA_DIR`, a server variable, so type
  it at the server's prompt rather than sending it from PowerShell:
  1. Open a shell (PowerShell):
     ```powershell
     fly ssh console -a eaa-chapter-site-lfhcfw
     ```
  2. At the server's prompt:
     ```sh
     /app/scripts/start.sh sh -c 'rm -rf "$DATA_DIR"/uploads/* ; : > "$DATA_DIR"/restore.sqlite'
     exit
     ```
  3. Back in PowerShell, restart, then seed if wanted:
     ```powershell
     fly apps restart eaa-chapter-site-lfhcfw
     fly ssh console -a eaa-chapter-site-lfhcfw -C "/app/scripts/start.sh npm run seed"
     ```
- **Photos from a snapshot:** create a volume from the snapshot (Fly's guide).
  The database on a snapshot can be a day older than the bucket's, so remove
  the database files from the restored volume before the site first starts on
  it, letting the latest come back from the bucket. Rare and fiddly; take care.

---

## Everyday operations

Commands are PowerShell. Run from the project folder, `fly` finds the app in
fly.toml; from anywhere else add `-a eaa-chapter-site-lfhcfw`. Anything run on
the server goes through `/app/scripts/start.sh`.

| Task | How |
|---|---|
| Deploy | push to `main` (Fly builds from GitHub), or `fly deploy` |
| Logs | `fly logs` |
| Shell on the server | `fly ssh console`, then type commands at the server's prompt (`sh`); `exit` to leave |
| Restart | `fly apps restart eaa-chapter-site-lfhcfw` |
| Secrets | `fly secrets list` / `set` / `unset` (each change restarts the machine) |
| Memory | set in fly.toml `[[vm]]`, **one value only**; `fly scale memory 512` applies now |
| Machine count | always 1: `fly scale count 1` |
| Admin password link | `/forgot` on the site; or `fly ssh console` and type at the **server's prompt**: `/app/scripts/start.sh node --input-type=module -e "const U=await import('/app/src/models/users.js');const {absoluteUrl}=await import('/app/src/middleware/base-path.js');const u=U.findByEmail('gary.jones@hawthorncs.com');console.log(u?absoluteUrl('/reset/'+U.createPasswordResetToken(u.id)):'no such account')"` |
| Invite someone | Members Corner → People → Invite a member |
| Approve a request | Members Corner → Requests |
| Fix a member's name/email | People → the member → Edit. Changing the email voids links sent to the old one; press Re-invite afterwards if they have no password yet |
| Remove a member | People → Edit → Remove (tick the box). Takes their tools, builds, borrow requests and comments; blog posts stay. Use Suspend to keep everything |
| Mail check | `fly ssh console -C "/app/scripts/start.sh npm run mail:check -- you@example.org"` |
| Backup check | `fly ssh console -C "/app/scripts/start.sh npm run backup:report -- --send"` |
| Correct pre-fix times | `fly ssh console -C "/app/scripts/start.sh npm run fix:times"` to preview; add ` -- --apply` inside the quotes to apply |
| Seed demo content | `fly ssh console -C "/app/scripts/start.sh npm run seed"` (only on an empty database; `FORCE_SEED=1` would duplicate and fails on the admin's unique email) |
| Download a copy of the database | Copying the live file alone can miss its latest changes (they sit in the `-wal`). Restore the backup to a side file, then download that: `fly ssh console -C "/app/scripts/start.sh litestream restore -config /app/litestream.yml -o /tmp/copy.sqlite /data/eaa1699.sqlite"`, then `fly ssh sftp get /tmp/copy.sqlite .\eaa1699-copy.sqlite`. It holds members' details: keep it safe and delete it after use |

The seed creates fictional members, tools, builds, events, posts and messages,
plus the admin account (no password), and prints a set-password link using
`BASE_URL`. It marks the database as already in chapter time.

---

## Developing and testing

### Run it

On Windows, in PowerShell, from the project folder:

```powershell
npm install
Copy-Item .env.example .env   # then put two New-Secret values (see Secrets) in
                              # SESSION_SECRET and CSRF_SECRET
npm run seed                  # prints a set-password link for the admin
npm run dev                   # http://localhost:3000
```

Node 23.4+ (24 recommended). Keep `MAIL_TRANSPORT=outbox` in development.
In a Linux container the same steps work in bash, with `cp` for `Copy-Item`.

### Tests

- `scripts/smoke.mjs`: about 110 HTTP-level checks: access control, CSRF
  (including multipart), origin checks, sanitisation, uploads, prefix handling,
  the mail queue, chapter-time conversions (forced to UTC), member admin.
  It creates and removes its own admin (`smoke.test.admin@example.com`), never
  touching real accounts. It **refuses to run when `MAIL_TRANSPORT=smtp`**,
  since it submits real forms. It reads the database directly, so it needs the
  same settings as the server it tests. In PowerShell, against a throwaway
  database in your temp folder:
  ```powershell
  $env:DATA_DIR       = Join-Path ([IO.Path]::GetTempPath()) 'eaa-test'
  $env:MAIL_TRANSPORT = 'outbox'
  $env:PORT           = '3101'
  $env:BASE_URL       = 'http://localhost:3101'
  $env:REDIRECT_MODE  = 'prefix'
  Remove-Item -Recurse -Force $env:DATA_DIR -ErrorAction SilentlyContinue
  npm run seed
  $server = Start-Process node -ArgumentList 'server.js' -PassThru
  Start-Sleep -Seconds 4
  node scripts/smoke.mjs
  Stop-Process -Id $server.Id
  ```
  The variables last for that PowerShell window only. `.env` should leave
  `BASE_PATH` empty, as `.env.example` does. To test as Fly runs, also set
  `$env:TZ = 'UTC'` before starting the server.

  The same in bash (Linux, CoderFlow):
  ```bash
  export DATA_DIR=/tmp/t BASE_PATH= MAIL_TRANSPORT=outbox PORT=3101 BASE_URL=http://localhost:3101
  npm run seed
  node server.js &        # TZ=UTC node server.js & to test as Fly runs
  node scripts/smoke.mjs
  ```
- `scripts/members-audit.mjs`: a real-browser walk through every members-area
  create/edit/cancel/delete path with uploads (52 checks). Needs
  `puppeteer-core` and a Chrome headless shell (it looks in `/tmp/pptr` by
  default; `PUPPETEER_ROOT`, `CHROME_PATH`).
- `scripts/borrow-notify-test.mjs`: drives one borrow request to confirm the
  owner is emailed.
- Always test against a throwaway `DATA_DIR`, never the database someone is
  using.

### Migrations

`src/db/migrate.js` is append-only and versioned (currently 1-7); it runs at
every server start. Never edit a migration that has been deployed; add a new
one. 6 corrected seeded wording about 4B0; 7 recorded the chapter-time cutoff
used by `scripts/fix-times.mjs`.

---

## Working in CoderFlow

CoderFlow tasks run in a Linux container, so the commands in this section are
bash.

- **Make the repository a managed repository of the environment.** For most of
  its life this site lived in `/workspace/eaa1699-website` without being one of
  CoderFlow's repositories. CoderFlow only captures changes to its own repos,
  so the site vanished whenever the task moved to a new container, twice. It
  was rebuilt each time by replaying the file edits recorded in the task's
  debug stream. Now that it is on GitHub, add
  `https://github.com/system21gary/eaa-chapter-site` to the environment and
  that problem goes away.
- **Leave changes uncommitted; Gary commits and pushes.** He has sometimes
  committed while an agent was still mid-change (one commit labelled as a
  backup-report fix also carried the time-zone fix). Check `git log` and
  `git status` before assuming what is pending.
- **Previewing in CoderFlow:** the site is reached through the code-server port
  proxy at `https://<coder host>/tasks/<task id>/vscode/proxy/3000/`. That
  proxy strips the path prefix and rewrites `Location` headers, which needs:
  `BASE_PATH=/tasks/<task id>/vscode/proxy/3000`,
  `BASE_URL=https://<coder host>:3000` and `REDIRECT_MODE=absolute` in the
  development `.env`. The task id changes with each task: `echo $TASK_ID`.
  The session cookie path stays `/` (the app sees the stripped path).
  The preview may instead be opened at `/tasks/<task id>/app/3000/` (the
  CoderFlow app proxy). `BASE_PATH` must match the URL actually in the
  browser, so use `BASE_PATH=/tasks/<task id>/app/3000` for that form. A
  mismatch gives an unstyled page with a broken image: the HTML loads but the
  CSS, JS and image links point at the wrong prefix and 404. Check the page's
  `<link rel="stylesheet">` href against the address bar. Restart the server
  after changing it.
- **Start a server that outlives the turn** with
  `setsid nohup node server.js > /tmp/eaa-server.log 2>&1 < /dev/null &`.
  Stop it with `for p in $(pgrep -f "^node server.js"); do kill $p; done`.
  `pkill -f "node server.js"` also matches and kills the shell running it.
- **Credentials:** never print or paste them. Check whether a variable is set
  with `[ -n "$VAR" ]`, compare values in code without printing them, and redact
  anything that slips into output.

---

## Lessons learned

Each of these cost real time. Most are now guarded by code or tests.

**Fly.io**
1. *Data vanished on every deploy:* no volume; the machine's disk is rebuilt
   on deploy and restart. Fixed with the `eaa_data` volume.
2. *Fly secrets override fly.toml.* The development settings from
   `.env.example`/`.env` (`DATA_DIR=./data`, `NODE_ENV=development`,
   `BASE_URL=http://localhost:3000`, `TRUST_PROXY=0`) were loaded as secrets,
   so the live site ran in development mode with its database at `/app/data`,
   on the disk wiped each deploy, and emailed links pointed at localhost.
   The site now warns at startup and in the backup report if its data is not
   on a separate device.
3. *`release_command` has no volume.* `npm run seed` there seeded a copy that
   was then deleted. Removed.
4. *Two machines:* the dashboard had scaled to two, and Fly demanded two
   volumes. With SQLite that would mean two different databases. One machine.
5. *Out of memory (exit 137):* fly.toml said both `memory = '1gb'` and
   `memory_mb = 256` (written by the dashboard), and 256 MB applied. Measured:
   site ~110 MB, seed ~170 MB peak, a large photo upload ~135 MB. Now 512 MB in
   one place. (Disabling libvips cache/threads made no measurable difference.)
6. *Shell traps.* Git Bash rewrote `fly ssh console -C "/app/..."` into a
   Windows path; PowerShell does not, which is one reason the runbook now uses
   PowerShell. PowerShell has its own: `$` in double quotes is expanded
   locally, so server variables like `$DATA_DIR` belong in single quotes or at
   the server's prompt. And `fly ssh` runs as root, leaving root-owned files:
   always go through `start.sh`.
7. *Deleting the database does not reset it*: the bucket restores it on boot.
   Use the `restore.sqlite` swap.

**Time**
8. *7 PM showed as 3 PM:* form times were parsed in the server's zone (UTC on
   Fly). Development containers ran in Eastern, so it never showed there. The
   edit form also refilled UTC, and a `truncate` filter appended "…" so the
   Start field came up empty. Fixed with `localtime.js`; tests force UTC.
   Rows saved before the fix need `npm run fix:times`.

**Email**
9. IONOS rejects a `From` that is not the authenticated mailbox (550), and a
   placeholder copied from a template (501). `MAIL_FROM` = `SMTP_USER`.
10. A test suite signing in as the real admin requested a reset on every run,
    voiding each link the admin had just been emailed ("the token was
    immediately expired"). Suites now use their own throwaway admin and refuse
    to run with live SMTP.
11. Sending inside a request would leak account existence on `/forgot` when the
    relay fails. Mail is queued; a worker delivers.

**Behind proxies (CoderFlow preview)**
12. Origin check compared against the internal host: allow `BASE_URL`.
13. Session cookie scoped to `BASE_PATH` while the proxy strips it: no session,
    empty CSRF token, 403. Cookie path is `/`.
14. code-server rewrites `Location` headers; the outer proxy does not. Neither
    prefixing nor not prefixing works: `REDIRECT_MODE=absolute`.
15. Links built from template expressions (`href="{{ ... }}"`) missed the prefix
    rewrite. All internal links go through the `url` filter; the smoke suite
    sweeps every page for unprefixed links.
16. A random `SESSION_SECRET` per start invalidated sessions on every restart.

**Application**
17. CSRF was checked before multer parsed multipart bodies, so every upload
    form returned 403. Verification now happens after multer.
18. The CSP blocked `blob:` images, so the upload preview showed nothing.
19. Image alt text, seed content and the About page described 4B0 as grass;
    migration 6 fixed seeded copies.
20. A backup report measuring only the main database file said 4 KB (recent
    data sits in the `-wal`); it now asks SQLite. Plain-text columns misalign in
    proportional mail fonts; it uses "Label: value" lines.
21. Removing a member must also delete pending invitations (accepting one would
    recreate the account) and their photo files. Changing an email must void
    links already sent to the old address.

**Repository**
22. Real secrets were committed in `.env.example` and in a `.env`. Rotate (see
    Secrets). `.gitignore` covers `.env` and `data/`.
23. The first push left unresolved merge-conflict markers in `.gitignore` and
    replaced the README with GitHub's placeholder; both were restored.

---

## Current state and open items

As of the last session. Things marked *verify* were last known to be pending
and should be checked rather than assumed.

**Working on the live site:** data on the volume; SMTP delivery through IONOS;
seed content; admin sign-in; the morning report email (it arrived, correctly
reporting PROBLEM: no bucket yet); member edit and removal (committed in
`e0ae432`, *verify* deployed).

**To do or verify**
1. *Verify* the published secrets have been rotated (`SESSION_SECRET`,
   `CSRF_SECRET`, `SMTP_PASS`). See [Secrets](#secrets).
2. *Verify* the Tigris bucket: `fly storage create`, restart, `fly logs` shows
   `Backup: Litestream to s3://...`, and
   `start.sh npm run backup:report -- --send` says **OK**. Until then nothing
   but the daily volume snapshot protects the database.
3. *Verify* `npm run fix:times` has been run on the live site (preview first;
   apply only if the "after" times are right). Before it, demo events showed
   4-5 hours early (VMC Club Night 2 PM instead of 7 PM).
4. *Verify* `fly secrets list` holds none of the settings in
   [Secrets that must NOT exist](#secrets-that-must-not-exist).
5. Decide what to do with **demo content**: the fictional members, tools,
   builds, events and posts. Removing a demo member also removes their demo
   tools and builds. An admin-only production seed (just the admin account) was
   offered but not built.
6. Tidy Gary's duplicate admin account if not wanted.
7. **Invite links are spent on the first GET.** Mail scanners (e.g. Microsoft
   365 Safe Links) open links to check them, which can burn an invitation
   before the person clicks. Fix offered, not built: make GET show a "Set up
   your account" button and consume the invite on POST (the reset flow already
   works this way).
8. SPF/DKIM/DMARC for the sending domain; check messages are not landing in
   spam.
9. A custom domain (e.g. `eaa1699.org`): `fly certs add`, DNS, then change
   `BASE_URL` in fly.toml (and `ALLOWED_ORIGINS` if both names stay in use).
10. Real content: real officers, events and photos to replace the demo set; the
    About page's history.
11. Minor: the footer's copyright year is computed when the server starts.
12. Optional: scrub secrets from Git history (after rotating).
13. The outreach brochure (`outreach/`) needs puppeteer to render its PDF; not
    installed in the last container.

---

## History

Condensed; Git has the code history from `ad55261` onwards.

- **Aug 14, 2026:** first build in CoderFlow, in its own folder (kept separate
  from the Profound Logic website repo). Researched the chapter on eaa.org
  and other chapter sites. Added members' builds, mock data with Gary as admin,
  request-and-approve accounts, masked contact details, and a walkthrough
  brochure for Ted (rewritten as a peer-to-peer explanation, no product pitch).
  Then preview fixes behind the CoderFlow proxy, password-reset 403s, the
  rich-text editor (Trix), and a full members-area browser audit that found the
  multipart CSRF, CSP and link-prefix bugs. Deployment planning: Cloud Run
  rejected for local-disk storage; a VM option documented. Outbound email via
  IONOS made to work, with a queued worker; borrow-request notifications
  confirmed; the "expired token" traced to the test suite.
- **Oct 8:** the container had been recycled and the site was gone; rebuilt by
  replaying the debug stream. It happened again; rebuilt again, faster.
- **Oct 9:** pushed to GitHub and deployed to Fly.io through the dashboard.
  Diagnosed data loss on deploy; added the volume, Litestream, the morning
  report, `start.sh` and the restore procedures; found the published secrets;
  fixed 4B0's description; fixed memory, the Git Bash and root-shell traps, and
  the `DATA_DIR` secret override. First report email arrived.
- **Oct 9-10:** chapter time for all dates, plus `fix:times` for old rows;
  member edit and removal; this runbook. 
