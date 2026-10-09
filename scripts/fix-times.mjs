/**
 * One-off: corrects dates saved while the site read form times in the
 * server's time zone instead of chapter time.
 *
 *   npm run fix:times              show what would change; change nothing
 *   npm run fix:times -- --apply   make the changes
 *
 * On Fly, from `fly ssh console` (type it at the server's prompt):
 *
 *   /app/scripts/start.sh npm run fix:times
 *
 * The old bug stored the time that was typed as if it were UTC: 7 PM went in
 * as 19:00Z and showed as 3 PM Eastern. The correction reads each affected
 * value's UTC clock time back as chapter time, so 19:00Z becomes 7 PM Eastern.
 *
 * Only for a database that was written by a server running in UTC (Fly). On a
 * server already in Eastern time the old code happened to be right, and this
 * would move everything by four or five hours. The preview shows exactly what
 * would move; if the "before" times look right, do not apply.
 *
 * Rows saved after the fixed code first started are never touched (migration
 * 7 recorded that moment), and it will not run twice.
 */
import { get, all, run, transaction, nowIso } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { zonedToUtc, TZ } from '../src/lib/localtime.js';

const apply = process.argv.includes('--apply');
migrate({ quiet: true });

const since = get("SELECT value FROM app_state WHERE key = 'chapter_time_since'")?.value;
if (!since) {
  console.error('Migration 7 has not run. Start the updated site once, then try again.');
  process.exit(1);
}
const done = get("SELECT value FROM app_state WHERE key = 'chapter_time_fixed'")?.value;
if (done) {
  console.log(
    /^\d{4}-/.test(done)
      ? `Already corrected on ${done}. Nothing to do.`
      : `Nothing to do: this database's times are already in chapter time (${done}).`
  );
  process.exit(0);
}

/** What to correct: table, the column naming the row, its date columns. */
const TARGETS = [
  { table: 'events', label: 'title', columns: ['starts_at', 'ends_at', 'rain_date'], changed: 'updated_at' },
  { table: 'builds', label: 'title', columns: ['started_on', 'first_flight_on'], changed: 'updated_at' },
  { table: 'build_updates', label: 'title', columns: ['posted_at'], changed: 'updated_at' },
  { table: 'borrow_requests', label: 'id', columns: ['needed_from', 'needed_to'], changed: 'created_at' },
];

const show = (iso) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/** The UTC clock reading of a stored value, read back as chapter time. */
function corrected(iso) {
  const d = new Date(iso);
  return zonedToUtc(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes()
  ).toISOString();
}

const changes = [];
for (const t of TARGETS) {
  const rows = all(
    `SELECT id, ${t.label} AS label, ${t.columns.join(', ')} FROM ${t.table}
      WHERE COALESCE(${t.changed}, created_at) < ? ORDER BY id`,
    [since]
  );
  for (const row of rows) {
    for (const col of t.columns) {
      if (!row[col]) continue;
      const after = corrected(row[col]);
      if (after !== row[col]) changes.push({ ...t, id: row.id, label: row.label, col, before: row[col], after });
    }
  }
}

if (!changes.length) {
  console.log('Nothing saved before the fix needs correcting.');
  process.exit(0);
}

console.log(`Saved before the fix (${show(since)}), and how each would move:\n`);
for (const c of changes) {
  const name = c.table === 'borrow_requests' ? `borrow request #${c.label}` : c.label;
  console.log(`  ${name} -- ${c.col.replace(/_/g, ' ')}: ${show(c.before)}  ->  ${show(c.after)}`);
}

if (!apply) {
  console.log(
    `\n${changes.length} value(s). Nothing has been changed.\n` +
      'If the times on the right are what was meant, run again with --apply:\n' +
      '  npm run fix:times -- --apply'
  );
  process.exit(0);
}

transaction(() => {
  for (const c of changes) {
    run(`UPDATE ${c.table} SET ${c.col} = ? WHERE id = ?`, [c.after, c.id]);
  }
  run("INSERT INTO app_state (key, value, updated_at) VALUES ('chapter_time_fixed', ?, ?)", [nowIso(), nowIso()]);
});
console.log(`\nCorrected ${changes.length} value(s).`);
