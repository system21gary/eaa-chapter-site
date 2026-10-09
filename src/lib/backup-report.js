import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import config from '../config.js';
import { get, all, run, nowIso } from '../db/index.js';
import { sendMail, outboxHealth } from './mailer.js';

/**
 * The nightly backup report.
 *
 * A backup nobody has restored is a hope, not a backup. So rather than report
 * that Litestream is running, this restores the latest copy from the bucket
 * into a scratch file every night and checks it: that it opens, that SQLite
 * says it is intact, and that it holds everything the live database held a
 * couple of minutes ago. The email says what it found, in plain words, and
 * says PROBLEM in the subject line when something needs doing.
 *
 * The database itself is never emailed. It holds every member's name, address,
 * phone number and password hash; a copy in an inbox is a copy outside every
 * protection the site has.
 */

const execFileAsync = promisify(execFile);
const TZ = 'America/New_York'; // 4B0 is Eastern; matches the site's filters

/** Tables summarised in the report, with the label used for each. */
const TRACKED = [
  ['users', 'Member accounts'],
  ['posts', 'Blog posts'],
  ['tools', 'Tools in the locker'],
  ['builds', 'Builds'],
  ['build_updates', 'Build log entries'],
  ['events', 'Events'],
  ['borrow_requests', 'Borrow requests'],
];

/**
 * How far behind the live database the restored copy may be. Litestream syncs
 * about once a second; anything written in this window may legitimately not
 * have reached the bucket yet, so it is not counted against the backup.
 */
const SETTLE_MS = 2 * 60 * 1000;

/** Free space on the volume below which the report warns. */
const LOW_DISK_FRACTION = 0.15;

/* ----------------------------------------------------------------- helpers */

function formatBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Number and total size of the files under a directory. */
function directoryUsage(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        bytes += fileSize(p);
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Today's date and the hour, in chapter time. */
export function localParts(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function localStamp(iso) {
  if (!iso) return 'never';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

/** Where the backup goes, without query parameters. Never holds credentials. */
function describeReplica(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'a configured replica';
  }
}

/* ------------------------------------------------------------ the checks */

/**
 * Whether the data directory is on a disk of its own, i.e. a mounted volume.
 *
 * On Fly, the container's own filesystem is rebuilt from the image on every
 * deploy and restart; only a volume survives. A data directory on the same
 * device as / is therefore erased on the next deploy. This happens quietly
 * when something overrides DATA_DIR -- a Fly secret beats fly.toml -- so it is
 * checked rather than assumed. Returns null where it cannot tell.
 */
export function storageProblem() {
  if (!config.isProd) return null;
  try {
    if (fs.statSync(config.dataDir).dev !== fs.statSync('/').dev) return null;
  } catch {
    return null;
  }
  return (
    `The database and photos are in ${config.dataDir}, on the container's own disk, ` +
    'not on the volume. Everything is erased on the next deploy or restart. ' +
    'Check `fly secrets list` for DATA_DIR, DB_FILE or UPLOAD_DIR overriding fly.toml.'
  );
}

/** Row counts per tracked table, from either database. */
function countRows(query) {
  const out = {};
  for (const [table] of TRACKED) {
    try {
      out[table] = query(`SELECT COUNT(*) AS n FROM ${table}`).n;
    } catch {
      out[table] = null;
    }
  }
  return out;
}

/**
 * Restores the latest backup into a scratch file and checks it against the
 * live database. Returns { ok, problem?, ... } and never throws.
 */
export async function verifyBackup() {
  if (!config.backup.replicaUrl) {
    return {
      ok: false,
      configured: false,
      problem: 'No backup is configured. The database is not being backed up at all.',
    };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaa-restore-'));
  const out = path.join(dir, 'restored.sqlite');
  const started = Date.now();
  const cutoff = new Date(started - SETTLE_MS).toISOString();
  const result = { configured: true, where: describeReplica(config.backup.replicaUrl) };

  try {
    try {
      await execFileAsync(
        'litestream',
        ['restore', '-config', config.backup.litestreamConfig, '-o', out, config.dbFile],
        // litestream.yml takes the database path from DB_FILE. start.sh exports
        // it, but pass it explicitly so the check works however it is started.
        { timeout: 5 * 60 * 1000, env: { ...process.env, DB_FILE: config.dbFile }, maxBuffer: 1024 * 1024 }
      );
    } catch (err) {
      const detail = String(err.stderr || err.message || err).trim().split('\n').slice(-3).join(' ');
      return { ...result, ok: false, problem: `The backup could not be restored: ${detail}` };
    }
    result.restoreSeconds = Math.round((Date.now() - started) / 100) / 10;
    result.restoredBytes = fileSize(out);

    const copy = new DatabaseSync(out, { readOnly: true });
    try {
      const integrity = Object.values(copy.prepare('PRAGMA integrity_check').get())[0];
      if (integrity !== 'ok') {
        return { ...result, ok: false, problem: `The restored copy failed SQLite's integrity check: ${integrity}` };
      }

      // Everything the live site recorded before the cutoff must be in the
      // copy. The activity log is append-only, so it is a fair measure.
      const sql = 'SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM audit_log WHERE created_at <= ?';
      const live = get(sql, [cutoff]);
      const restored = copy.prepare(sql).get(cutoff);
      result.liveCounts = countRows((q) => get(q));
      result.restoredCounts = countRows((q) => copy.prepare(q).get());
      result.restoredLatest = copy.prepare('SELECT MAX(created_at) AS t FROM audit_log').get().t;

      if (restored.n < live.n) {
        const missingSince = get(
          'SELECT created_at FROM audit_log WHERE created_at <= ? ORDER BY id LIMIT 1 OFFSET ?',
          [cutoff, restored.n]
        )?.created_at;
        return {
          ...result,
          ok: false,
          problem:
            `The backup is behind: it is missing ${live.n - restored.n} recorded change(s), ` +
            `the oldest from ${localStamp(missingSince)}. Litestream may have stopped syncing.`,
        };
      }
    } finally {
      copy.close();
    }
    return { ...result, ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Everything the report says, gathered in one place. */
export async function buildReport() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const report = {
    generatedAt: nowIso(),
    backup: await verifyBackup(),
    // The main file only. Litestream holds checkpoints back while it copies,
    // so the -wal beside it is routinely several times larger and says more
    // about timing than about how much the chapter has stored.
    database: { bytes: fileSize(config.dbFile) },
    uploads: directoryUsage(config.uploadDir),
    newToday: {},
    warnings: [],
  };

  for (const [table] of TRACKED) {
    try {
      report.newToday[table] = get(`SELECT COUNT(*) AS n FROM ${table} WHERE created_at >= ?`, [since]).n;
    } catch {
      report.newToday[table] = null;
    }
  }

  try {
    const s = fs.statfsSync(config.dataDir);
    report.disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    if (report.disk.free / report.disk.total < LOW_DISK_FRACTION) {
      report.warnings.push(
        `The data volume is ${Math.round((1 - report.disk.free / report.disk.total) * 100)}% full ` +
          `(${formatBytes(report.disk.free)} free). Uploads will start failing when it fills.`
      );
    }
  } catch {
    report.disk = null;
  }

  const mail = outboxHealth();
  if (mail.abandoned > 0) {
    report.warnings.push(
      `${mail.abandoned} email(s) could not be delivered and were given up on. ` +
        'See Members Corner > Admin > Activity log.'
    );
  }

  report.storageProblem = storageProblem();
  report.status =
    !report.backup.ok || report.storageProblem ? 'PROBLEM' : report.warnings.length ? 'WARNING' : 'OK';
  return report;
}

/** The report as an email. */
export function formatReport(report) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric' }).format(
    new Date(report.generatedAt)
  );
  const b = report.backup;
  const lines = [];

  if (report.status === 'PROBLEM') {
    lines.push('ACTION NEEDED', '');
    if (report.storageProblem) lines.push(report.storageProblem, '');
    if (!b.ok) lines.push(b.problem, '');
  } else {
    lines.push(
      'The backup is working.',
      '',
      `This check restored the latest copy from ${b.where} ` +
        `(${formatBytes(b.restoredBytes)}, ${b.restoreSeconds}s), confirmed it is intact, ` +
        'and confirmed it holds everything the live site had recorded up to two minutes before the check.',
      ''
    );
  }

  if (report.warnings.length) {
    lines.push('Also worth a look:', ...report.warnings.map((w) => `  - ${w}`), '');
  }

  lines.push('What is stored', '');
  for (const [table, label] of TRACKED) {
    const live = b.liveCounts?.[table] ?? get(`SELECT COUNT(*) AS n FROM ${table}`)?.n;
    const added = report.newToday[table];
    const restored = b.restoredCounts?.[table];
    const extra = [];
    if (added) extra.push(`${added} new in the last day`);
    if (restored != null && restored !== live) extra.push(`${restored} in the backup`);
    lines.push(`  ${label.padEnd(22)} ${String(live).padStart(5)}${extra.length ? `   (${extra.join(', ')})` : ''}`);
  }
  lines.push(
    '',
    `  Database               ${formatBytes(report.database.bytes)}`,
    `  Uploaded photos        ${report.uploads.files} files, ${formatBytes(report.uploads.bytes)}`
  );
  if (report.disk) {
    lines.push(`  Volume free space      ${formatBytes(report.disk.free)} of ${formatBytes(report.disk.total)}`);
  }
  if (b.restoredLatest) {
    lines.push(`  Last change backed up  ${localStamp(b.restoredLatest)}`);
  }

  lines.push(
    '',
    'How the site is backed up',
    '',
    '  - The database is copied to the backup bucket within about a second of',
    '    every change, with 30 days of history. Any moment in that window can be',
    '    restored.',
    '  - Fly.io snapshots the whole volume, photos included, once a day and keeps',
    '    30 days. List them with:  fly volumes snapshots list <volume id>',
    '  - If the volume is ever lost, the site restores the database from the',
    '    bucket by itself the next time it starts.',
    '',
    'Restore steps are in DEPLOY.md, under "Restoring".',
    '',
    '--',
    'Sent automatically each morning by the EAA Chapter 1699 website.',
    'To stop these: set BACKUP_REPORT=0. To change who gets them: BACKUP_REPORT_TO.'
  );

  const subject =
    report.status === 'PROBLEM'
      ? `EAA 1699 backup: PROBLEM (${day})`
      : report.status === 'WARNING'
        ? `EAA 1699 backup: OK, with a warning (${day})`
        : `EAA 1699 backup: OK (${day})`;

  return { subject, text: lines.join('\n') };
}

/** Who gets it: BACKUP_REPORT_TO, or else every active administrator. */
export function reportRecipients() {
  if (config.backup.reportTo.length) return config.backup.reportTo;
  return all("SELECT email FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id").map((r) => r.email);
}

/** Builds the report and queues one email per recipient. */
export async function sendReport() {
  const report = await buildReport();
  const message = formatReport(report);
  const recipients = reportRecipients();
  for (const to of recipients) {
    await sendMail({ to, ...message });
  }
  return { report, message, recipients };
}

/* --------------------------------------------------------------- schedule */

/**
 * Sends today's report if it is past the report hour and nobody has sent it
 * yet. "Nobody" includes this server before a restart, and any other process:
 * the day is claimed in the database before anything is sent, so a restart or
 * a second instance cannot send it twice.
 */
export async function maybeSendDailyReport(now = new Date()) {
  const { date, hour } = localParts(now);
  if (hour < config.backup.reportHour) return false;

  const claimed = run(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('backup_report_date', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE app_state.value <> excluded.value`,
    [date, nowIso()]
  ).changes;
  if (!claimed) return false;

  const { report, recipients } = await sendReport();
  console.log(`[backup] daily report: ${report.status}, queued for ${recipients.length} recipient(s)`);
  return true;
}

let timer = null;
let firstRun = null;

/**
 * Checks every ten minutes whether today's report is due. The first check
 * waits a few minutes after boot so that, right after a deploy, Litestream
 * has had time to push the database before the report tries to restore it.
 */
export function startBackupReporter() {
  if (!config.backup.reportEnabled || timer) return false;
  const tick = () => maybeSendDailyReport().catch((err) => console.error('[backup] report failed:', err.message));
  firstRun = setTimeout(tick, 3 * 60 * 1000);
  firstRun.unref();
  timer = setInterval(tick, 10 * 60 * 1000);
  timer.unref();
  return true;
}

export function stopBackupReporter() {
  if (firstRun) clearTimeout(firstRun);
  if (timer) clearInterval(timer);
  timer = null;
  firstRun = null;
}

export { describeReplica };
