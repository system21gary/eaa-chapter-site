# Deploying

The site runs on **Fly.io**. The first section below is how it is set up and
looked after there. The Cloud Run and VM notes further down are kept for
reference, in case it ever moves.

## Fly.io

### Where the data lives, and how it is backed up

A Fly machine's own disk is rebuilt from the Docker image on **every deploy and
every restart**, so nothing the site stores can live there. Instead:

| What | Where | Backup |
|---|---|---|
| Database (members, posts, tools, builds, events, everything typed in) | `/data/eaa1699.sqlite` on the Fly volume `eaa_data` | **Litestream** copies every change to a Tigris bucket within about a second, with 30 days of history. Any moment in those 30 days can be restored. |
| Uploaded photos | `/data/uploads/` on the same volume | **Fly volume snapshots**, daily, kept 30 days. |

On top of that:

- **If the volume is ever lost**, the site restores the database from the
  bucket by itself the next time it starts (`scripts/start.sh`).
- **Every morning after 6:00 Eastern**, the site emails the administrators a
  backup report. It does not just check that Litestream is running: it restores
  the latest copy from the bucket into a scratch file, checks SQLite's
  integrity, and checks the copy holds everything the live site had recorded.
  The subject says **PROBLEM** when something needs doing. Run it on demand:

  ```bash
  fly ssh console -C "/app/scripts/start.sh npm run backup:report -- --send"
  ```

The database itself is never emailed. It holds every member's contact details
and password hash.

### Setting it up

You need `flyctl` (`curl -L https://fly.io/install.sh | sh`, then
`fly auth login`). Run these from the project folder.

**1. Save anything on the current machine.** Before the volume, the database
lived inside the container, so the next deploy deletes it. If there is real
content on the live site, download it first:

```bash
fly ssh sftp get /app/data/eaa1699.sqlite ./eaa1699-before-volume.sqlite
```

**2. Create the volume**, in the same region as the app:

```bash
fly volumes create eaa_data --region iad --size 1
```

It warns that a single volume has no redundancy. That is expected: the bucket
backup and the snapshots are the redundancy. Answer yes.

**3. Create the backup bucket:**

```bash
fly storage create
```

Pick a name such as `eaa1699-backups`. This creates a private Tigris bucket and
sets `BUCKET_NAME` and the `AWS_*` credentials as app secrets. `start.sh`
picks them up; nothing else to configure.

**4. Set the secrets.** These are never in a file in the repository.

```bash
fly secrets set \
  SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  CSRF_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"

fly secrets set MAIL_TRANSPORT=smtp SMTP_HOST=smtp.ionos.com SMTP_PORT=587 SMTP_SECURE=0 \
  SMTP_USER='the mailbox address' SMTP_PASS='its password' \
  MAIL_FROM='EAA Chapter 1699 <the same mailbox address>'

# Optional: who gets the morning backup report. Default: every active admin.
fly secrets set BACKUP_REPORT_TO=gary.jones@hawthorncs.com
```

`fly secrets list` shows which are set, never their values.

**5. Deploy and keep it to one machine:**

```bash
fly deploy
fly scale count 1
```

One machine, always. SQLite lives on one volume attached to one machine; a
second machine would have its own, separate database.

**6. Seed a brand-new site** (skip this if you are restoring data):

```bash
fly ssh console -C "/app/scripts/start.sh npm run seed"
```

It prints a link to set the admin password. Always run one-off commands
through `start.sh`: `fly ssh console` logs in as root, and a command run as
root leaves files on the volume the site cannot write to.

**7. Check it.** `fly logs` should show `Backup: Litestream to s3://…` at
startup. Give it a minute after the deploy, then send yourself a report:

```bash
fly ssh console -C "/app/scripts/start.sh npm run backup:report -- --send"
```

### What changed in fly.toml, and why

- **`[mounts]`**: the volume, with snapshots kept 30 days instead of 5, and
  automatic growth (1 GB more at 80% full, up to 5 GB) so photo uploads do not
  start failing when it fills.
- **`DATA_DIR = '/data'`**: puts the database and uploads on the volume.
- **`release_command` removed.** It ran `npm run seed` on a temporary machine
  that Fly creates without the volume and then deletes, so it seeded a copy
  nobody ever saw.
- **`PORT = '3000'`** to match `internal_port`. The Dockerfile defaults to 8080.
- **`TRUST_PROXY = '1'`** and **`BASE_URL`**: Fly's proxy handles HTTPS, and
  emailed links need the public address. Change `BASE_URL` if the site moves to
  its own domain.

### Restoring

**The volume or the machine is lost.** Create a new volume with the same name
(step 2) and deploy. The site finds no database, restores the latest copy from
the bucket, and starts.

**Something was deleted or changed by mistake.** Roll the database back to a
moment before it happened. Times are UTC: 10:30 Eastern in October is 14:30Z.

```bash
# 1. Restore that moment to a side file. The site keeps running.
fly ssh console -C "/app/scripts/start.sh litestream restore -config /app/litestream.yml -timestamp 2026-10-09T14:30:00Z -o /data/restore.sqlite /data/eaa1699.sqlite"

# 2. Restart. start.sh swaps the restored copy in before the site opens it.
fly apps restart
```

The database it replaces is kept on the volume as
`eaa1699.sqlite.before-restore-<time>`, in case the rollback itself was the
mistake. Anything entered between the chosen moment and the rollback is not in
the restored copy. The backup carries on from the rolled-back state.

**Photos.** Fly's daily snapshots cover them: `fly volumes list`, then
`fly volumes snapshots list <volume id>`. Restoring a snapshot means creating
a new volume from it ([Fly's guide](https://fly.io/docs/volumes/snapshots/)).
One catch: the database on a snapshot can be up to a day old, older than the
one in the bucket. Before the site first starts on a restored volume, the
database files on it should be removed, so the latest database comes back from
the bucket instead. It is a rare and fiddly job; ask before doing it.

### Credentials that were published

`.env.example` is a template and is public. If real values ever go into it,
they are published with the repository and stay in its Git history even after
the file is fixed. Treat them as known to anyone and change them:

1. **The mailbox password**: change it in IONOS, then update `SMTP_PASS` in
   `fly secrets` and in any local `.env`.
2. **`SESSION_SECRET` and `CSRF_SECRET`**: set new ones (step 4). Everyone is
   signed out once, which is the point.

Real values belong in `fly secrets` for the live site, and in `.env` (which Git
ignores) on a development machine.

## Other hosts (kept for reference)

### Cloud Run will lose the chapter's data

`gcloud run deploy --source .` will work. The site will come up, look perfect,
and then quietly throw away everything anyone types into it.

Cloud Run gives each container instance an **in-memory filesystem that is
destroyed when the instance stops** — and instances stop constantly, because
scaling to zero is the point. This app keeps two things on local disk:

| On disk | Contains |
|---|---|
| `data/eaa1699.sqlite` | members and passwords, blog posts, tools, borrow requests, build logs, events, membership requests, sessions, audit log |
| `data/uploads/` | every uploaded photo — covers, tool photos, build photos, avatars, event posters |

So on Cloud Run, as shipped:

- After ~15 minutes of no traffic the instance shuts down and **everything
  since the last deploy is gone**. New members, new posts, new photos.
- Every redeploy starts from an empty database.
- If traffic ever warrants two instances, they get **separate databases** and
  members see different content depending on which one answers.

None of that shows up in a quick test, which is exactly what makes it
dangerous: you would find out weeks later, from a member asking where their
build log went.

**Pick a storage plan before deploying anywhere real.** Two sensible ones
follow.

---

### Option A — one small VM, no code changes

Best fit for a chapter site. The app was built as one process and one file on
disk; a VM with a persistent disk is exactly that, and nothing needs porting.

- **Cost:** an `e2-micro` is in Google's free tier in `us-west1`, `us-central1`
  and `us-east1` (one instance per month, 30 GB disk). Otherwise ~$7/month.
- **Backups:** scheduled disk snapshots, or `sqlite3 .backup` to a Cloud Storage
  bucket on a cron. The whole site is one file — backup is a copy.
- **TLS:** Caddy gets and renews a certificate automatically.
- **Trade-off:** you patch the VM. It does not scale horizontally — which for a
  few hundred visitors a month it does not need to.

```bash
# 1. Create the instance and open the web ports
gcloud compute instances create eaa1699 \
  --machine-type=e2-micro --zone=us-central1-a \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --tags=http-server,https-server

gcloud compute firewall-rules create allow-web \
  --allow=tcp:80,tcp:443 --target-tags=http-server,https-server

# 2. Reserve a static IP and point eaa1699.org at it
gcloud compute addresses create eaa1699-ip --region=us-central1

# 3. On the instance
gcloud compute ssh eaa1699 --zone=us-central1-a

  # Node 24 and Caddy
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs caddy git

  # The app, its data directory, and a user to run it
  sudo useradd --system --home /srv/eaa1699 --create-home eaa1699
  sudo -u eaa1699 git clone <your-repo> /srv/eaa1699/app
  cd /srv/eaa1699/app && sudo -u eaa1699 npm ci --omit=dev
  sudo -u eaa1699 mkdir -p /srv/eaa1699/data

  # Secrets and settings
  sudo -u eaa1699 tee /srv/eaa1699/app/.env >/dev/null <<EOF
  NODE_ENV=production
  PORT=3000
  BASE_URL=https://eaa1699.org
  DATA_DIR=/srv/eaa1699/data
  DB_FILE=/srv/eaa1699/data/eaa1699.sqlite
  UPLOAD_DIR=/srv/eaa1699/data/uploads
  TRUST_PROXY=1
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  CSRF_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")
  MAIL_TRANSPORT=smtp
  SMTP_HOST=smtp.example.com
  SMTP_PORT=587
  SMTP_USER=<the sending account>
  SMTP_PASS=<an app-specific password>
  MAIL_FROM=EAA Chapter 1699 <no-reply@eaa1699.org>
  MAIL_REPLY_TO=info@eaa1699.org
  EOF
  # The only copy of the SMTP password on the machine. Keep it unreadable to
  # everyone but the service account, and out of the repository.
  sudo chown eaa1699 /srv/eaa1699/app/.env
  sudo chmod 600 /srv/eaa1699/app/.env

  # Prove mail works before anyone depends on it
  cd /srv/eaa1699/app && sudo -u eaa1699 npm run mail:check -- you@example.com

  # Run it under systemd
  sudo tee /etc/systemd/system/eaa1699.service >/dev/null <<'EOF'
  [Unit]
  Description=EAA Chapter 1699 website
  After=network.target
  [Service]
  Type=simple
  User=eaa1699
  WorkingDirectory=/srv/eaa1699/app
  ExecStart=/usr/bin/node server.js
  Restart=always
  RestartSec=5
  [Install]
  WantedBy=multi-user.target
  EOF
  sudo systemctl enable --now eaa1699

  # TLS and reverse proxy
  sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
  eaa1699.org, www.eaa1699.org {
    reverse_proxy 127.0.0.1:3000
  }
  EOF
  sudo systemctl restart caddy
```

Then open `https://eaa1699.org/` and set the admin password from the link
`npm run seed` prints (or run the site empty and invite yourself).

**Note on `REDIRECT_MODE`:** leave it unset. Caddy does not rewrite `Location`
headers, so the default is correct.

**Note on outbound mail from a Google Cloud VM:** port 25 is blocked outright,
in every direction, with no way to open it. That rules out delivering straight
to recipients' mail servers — which is fine, because the site is configured to
relay through a provider on 587 or 465 anyway. Those ports are open.

---

### Option B — Cloud Run, done properly

Managed, scales to zero, no VM to patch. It needs both stateful things moved
off local disk first:

1. **Database → Cloud SQL for PostgreSQL.** Real work: every model file uses
   `node:sqlite` prepared statements directly. Roughly 5 model files, the
   migration runner and the session store need a query layer they can share.
   A day's work, and the schema is already plain SQL that ports cleanly.
2. **Uploads → Cloud Storage.** Smaller: `src/lib/images.js` writes two WebP
   files per upload and `src/routes/media.js` serves them. Both would go
   through the GCS SDK instead of `fs`. The sanitising and re-encoding logic is
   unchanged.

- **Cost:** Cloud Run itself is near zero at this traffic. Cloud SQL is the
  floor — a `db-f1-micro` is roughly **$9–25/month**, more than everything else
  in the stack combined and more than the VM in Option A.
- **Why not a Cloud Storage volume mount for the database?** GCSFuse has no
  POSIX file locking, which SQLite depends on. It will corrupt the file. NFS via
  Filestore is likewise not safe for SQLite, and Filestore's minimum instance
  costs far more than the VM.

If you want this, say so and I will do the port. It is a real change, not a
config tweak, so I have not made it speculatively.

#### Once storage is sorted, deploying is:

```bash
gcloud run deploy eaa1699 --source . \
  --region=us-central1 \
  --allow-unauthenticated \
  --min-instances=0 \
  --set-env-vars=NODE_ENV=production,TRUST_PROXY=1,BASE_URL=https://your-service-url \
  --set-secrets=SESSION_SECRET=eaa1699-session:latest,CSRF_SECRET=eaa1699-csrf:latest
```

Create the secrets once:

```bash
for name in eaa1699-session eaa1699-csrf; do
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" \
    | gcloud secrets create "$name" --data-file=-
done
```

`--source .` uses the `Dockerfile` in this repository rather than buildpacks.
That is deliberate: buildpacks resolve the *lowest* Node version satisfying
`engines`, and this app needs 23.4+ for its built-in SQLite. The Dockerfile
pins Node 24.

---

## Settings that matter in production

| Variable | Why |
|---|---|
| `SESSION_SECRET`, `CSRF_SECRET` | **Required.** The app refuses to start in production without them rather than fall back to something guessable. Both at least 32 characters. |
| `BASE_URL` | The public origin. Used for the form-submission origin check and for links in emails. Behind any proxy this must be set or every POST is refused as cross-origin. |
| `TRUST_PROXY=1` | Set only when genuinely behind a proxy you control. It makes `req.ip` and `Secure` cookies reflect the real connection; trusting those headers when not behind a proxy lets a client spoof its IP past the rate limits. |
| `DATA_DIR` | Point at the persistent volume. |
| `MAIL_TRANSPORT` | `smtp` to actually deliver, plus `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`. The app refuses to start if you ask for `smtp` without them, rather than silently queueing mail nobody receives. See **Email** below. |
| `REDIRECT_MODE` | Leave unset for nginx/Caddy/Cloud Run. Only needed behind a proxy that rewrites `Location` headers. |
| `BASE_PATH` | Leave unset when the site owns its domain. |

`NODE_ENV=production` also turns on HSTS, `Secure` cookies, and suppresses
stack traces in error responses.

## Email

Email is not a nice-to-have here. A member cannot get in without an invitation,
and cannot get back in without a reset link, so until this works the Members
Corner has exactly one account: the one seeded on the command line.

### What the site needs

**SMTP, not IMAP.** IMAP reads a mailbox; it cannot send. Every mail provider
offers both, and for most of them the username and password are the same for
each — it is the hostname and port that differ. So if you have working IMAP
credentials, you almost certainly have the right *account*; you need its SMTP
settings.

Set these and restart:

```ini
MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587        # 587 with STARTTLS is what you want
SMTP_SECURE=0        # 1 only for port 465
SMTP_USER=<the full email address, usually>
SMTP_PASS=<an app-specific password, not the account password>
MAIL_FROM=EAA Chapter 1699 <no-reply@eaa1699.org>
MAIL_REPLY_TO=info@eaa1699.org
```

Then check it, before any member depends on it:

```bash
npm run mail:check                      # connect and authenticate only
npm run mail:check -- you@example.com   # and send yourself a real one
```

That exercises the same config, transport and TLS settings the site uses, so if
it passes, invitations and resets will go out. It prints no credential values,
and it diagnoses the usual failures rather than just echoing the error.

### Settings by provider

| Provider | Host | Port | Note |
|---|---|---|---|
| **IONOS** (in use) | `smtp.ionos.com` | 587 | **`MAIL_FROM` must be the mailbox that authenticates.** Anything else is refused with `550 Sender address is not allowed`. Put the address you want replies to go to in `MAIL_REPLY_TO`. |
| Gmail / Google Workspace | `smtp.gmail.com` | 587 | Needs an **app password**, which needs 2-step verification enabled first. Your normal password will be rejected. ~500 messages/day. |
| Microsoft 365 | `smtp.office365.com` | 587 | App password, and SMTP AUTH is disabled by default on the tenant — an admin has to switch it on for the mailbox. |
| Fastmail | `smtp.fastmail.com` | 465 (`SMTP_SECURE=1`) | App password, created per application. |
| Postmark | `smtp.postmarkapp.com` | 587 | Server token as both user and password. Free tier ~100/month. Best deliverability of the lot. |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SMTP credentials are *not* your AWS keys — generate them in the SES console. Starts in a sandbox that only sends to verified addresses. |
| Resend / SendGrid / Mailgun | provider's host | 587 | API key as the password, literal `resend` / `apikey` as the username. |

For a chapter of this size any of these is free or nearly so. A transactional
service (Postmark, SES, Resend) is the better choice over a personal mailbox:
reset links do not get caught in a sending limit, and you can see what was
delivered.

### Landing in the inbox rather than the spam folder

Sending is the easy half. If `MAIL_FROM` is `@eaa1699.org`, receiving servers
check whether your sender is allowed to send as that domain, and if the answer
is unclear they take the safe option. Add these DNS records for the domain:

- **SPF** — a TXT record at the domain root naming your sender, e.g.
  `v=spf1 include:spf.messagingengine.com ~all`. Exactly one SPF record; a
  second one invalidates both.
- **DKIM** — the CNAME or TXT records your provider gives you. This is the one
  that matters most.
- **DMARC** — a TXT record at `_dmarc.eaa1699.org`, starting at
  `v=DMARC1; p=none; rua=mailto:postmaster@eaa1699.org` so you get reports
  before you start enforcing.

Send yourself a test with `npm run mail:check` and check the spam folder too. If
it landed there, it is nearly always DKIM.

### How delivery behaves

Messages are written to the `email_outbox` table first and delivered by a
background worker, never inside the web request that triggered them. That is
deliberate, for two reasons:

- A relay hiccup must not fail an action that already succeeded. The membership
  request is saved either way; the member should not see an error page because
  the mail server was slow.
- `/forgot` answers identically for a registered address and an unknown one, on
  purpose. Sending in-request would break that — only a registered address
  attempts delivery, so only it can fail, and the difference tells an attacker
  which addresses have accounts.

A failed message is retried after 1, 5, 15, 60 and 240 minutes, then left with
its error for an administrator. **Members Corner → Activity log** lists the
queue with the reason for each failure and a **Retry now** button, so the usual
sequence — get a setting wrong, fix it, resend the invitation that bounced off
it — does not need the command line.

### Two guards against emailing fictional people

The site ships with demo members and its test suites submit real forms, so
turning on SMTP in a development environment can quietly post mail to addresses
that cannot receive it. Enough bounces against a new sending domain is how a
chapter's mail starts landing in everyone's spam folder. So:

- **Reserved domains are never attempted.** Anything at `example.com`,
  `example.org`, `example.net`, `test`, `invalid` or `localhost` is recorded as
  not sent, with the reason. `MAIL_SUPPRESS_DOMAINS` overrides the list.
- **`scripts/smoke.mjs` refuses to run** when `.env` has `MAIL_TRANSPORT=smtp`,
  because the suite requests a password reset and submits the contact form on
  every run. Restart the server with `MAIL_TRANSPORT=outbox` to test without
  sending, or pass `--allow-live-mail` deliberately.

Neither protects `CONTACT_EMAIL`: it is a real address on a real domain, and
every contact-form submission and membership request goes to it. Make sure it is
a mailbox somebody actually reads, or those messages bounce back at whatever
`MAIL_FROM` is.

### One deliberate omission

Switching `MAIL_TRANSPORT` to `smtp` does **not**
flush what was queued beforehand. That backlog is mostly demo content addressed
to fictional members, and posting it all on day one would earn a brand-new
domain a pile of bounces. Anything genuinely worth sending can be retried
individually from the activity log.

## Before telling the membership about it

- [ ] **Email** configured and verified with `npm run mail:check`, including
      SPF/DKIM/DMARC. See above. Nothing else matters until this works.
- [ ] **Backups.** Snapshot the disk (Option A) or enable automated backups
      (Option B). Test a restore once.
- [ ] **Uptime check** against `/healthz`.
- [ ] Replace the fictional demo members and the machine-generated imagery.
- [ ] Confirm the event contact details before republishing anyone's phone
      number — the seeded ones are deliberately placeholders.

## Verifying a deployment

```bash
BASE_URL=https://eaa1699.org node scripts/smoke.mjs
```

Both suites create their own throwaway administrator on a reserved
documentation domain and delete it again at the end, so neither one touches a
real member's account. That matters more than it sounds: they used to sign in as
the chapter admin, and because **issuing a password reset token invalidates any
outstanding one**, a test run could silently kill a reset link an officer was
half-way through using. It looked exactly like "the link expired immediately".

They do still create and delete real content (a post, a tool, a build, an
event), so prefer a staging deployment. And note the mail guard: with
`MAIL_TRANSPORT=smtp` in `.env` the smoke suite refuses to run without
`--allow-live-mail`, because it submits the contact form and requests a
password reset on every pass.

### If a reset link says it has expired

In order of likelihood:

1. **A newer reset was requested.** Only the most recent link works — asking
   again invalidates the previous one, which is the correct behaviour but does
   mean the oldest email in an inbox is the wrong one to click. Use the newest.
2. **It has already been used.** Links are single-use.
3. **It is over an hour old** (`RESET_TOKEN_TTL_MINUTES`, default 60).
4. **A test run took it.** See above — no longer possible.

`GET /reset/:token` deliberately only *peeks* at the token, so a mail client or
security scanner prefetching the link does not consume it. Only submitting the
form spends it.
