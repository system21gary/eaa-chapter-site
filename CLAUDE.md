# EAA Chapter 1699 website

Read **[RUNBOOK.md](RUNBOOK.md)** first. It records where the site runs
(Fly.io app `eaa-chapter-site-lfhcfw`), how data is kept and backed up, which
secrets exist and where, what is still open, and the lessons behind the
current design. README.md covers the application; DEPLOY.md the procedures.

Rules that have each cost real time to learn:

- **No secret values in the repository**, ever. This repo is public. Live
  values are Fly secrets; development values are in the git-ignored `.env`.
  `.env.example` holds placeholders only. Never print credentials.
- **Settings are not secrets.** `NODE_ENV`, `PORT`, `BASE_URL`, `TRUST_PROXY`,
  `DATA_DIR`, `DB_FILE`, `UPLOAD_DIR` belong in fly.toml `[env]`; as Fly secrets
  they override it and break the site.
- **One Fly machine, data under `/data`.** The machine's own disk is wiped on
  every deploy and restart. No `release_command` (it has no volume).
- **On the server, run one-off commands through `/app/scripts/start.sh`**
  (`fly ssh console` is root).
- **Give Gary flyctl commands in PowerShell** (his Windows shell): `$` inside
  double quotes is expanded locally, so commands using server variables go in
  single quotes or at the server's prompt; line continuation is a backtick.
  Commands typed at the server's prompt are `sh`. RUNBOOK.md shows the patterns,
  tested in PowerShell 7.
- **Dates from forms are chapter time** (America/New_York). Use
  `src/lib/localtime.js`; never parse form text with `new Date()` or use
  `setHours()`. Fly runs in UTC.
- **Migrations are append-only.** Add a new version; never edit a deployed one.
- **Upload routes verify CSRF after multer** (`verifyMultipartCsrf`).
- **Internal links go through the `url` filter**, so the site works under a
  path prefix (the CoderFlow preview proxy).
- **Test against a throwaway `DATA_DIR`** with `MAIL_TRANSPORT=outbox`, and run
  `scripts/smoke.mjs` (also with the server under `TZ=UTC`). The suite uses its
  own admin and refuses to run with live SMTP.
- **Leave changes uncommitted**; Gary reviews, commits and pushes. Check
  `git status`/`git log` first: he sometimes commits mid-change.
