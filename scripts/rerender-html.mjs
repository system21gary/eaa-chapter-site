/**
 * One-off: re-renders the stored HTML of member-written content from its
 * markdown, so content saved before a change to the renderer picks it up.
 *
 *   npm run rerender              show what would change; change nothing
 *   npm run rerender -- --apply   make the changes
 *
 * On Fly, from `fly ssh console` (type it at the server's prompt):
 *
 *   /app/scripts/start.sh npm run rerender
 *
 * Written for the fix that makes links to other sites open in a new tab: the
 * renderer meant to add target="_blank" all along, but the attribute was being
 * stripped, so every post, event and build saved before the fix has links that
 * open in place. Content is re-rendered with exactly the code that renders it
 * on save; the markdown itself is never touched, so it is safe to run again
 * (a second run finds nothing to change).
 */
import { all, run, transaction } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { renderMarkdown } from '../src/lib/markdown.js';

const apply = process.argv.includes('--apply');
migrate({ quiet: true });

// table, markdown column, html column
const FIELDS = [
  ['posts', 'body_md', 'body_html'],
  ['events', 'body_md', 'body_html'],
  ['events', 'recap_md', 'recap_html'],
  ['builds', 'body_md', 'body_html'],
  ['build_updates', 'body_md', 'body_html'],
];

const changes = [];
for (const [table, mdCol, htmlCol] of FIELDS) {
  const rows = all(`SELECT id, ${mdCol} AS md, ${htmlCol} AS html FROM ${table} WHERE ${mdCol} IS NOT NULL AND ${mdCol} != ''`);
  let n = 0;
  for (const r of rows) {
    const html = renderMarkdown(r.md);
    if (html !== r.html) {
      changes.push({ table, htmlCol, id: r.id, html });
      n += 1;
    }
  }
  console.log(`${table}.${htmlCol}: ${n} of ${rows.length} would change`);
}

if (!changes.length) {
  console.log('Nothing to do.');
} else if (!apply) {
  console.log(`\n${changes.length} in all. Nothing changed. Run again with --apply to update them.`);
} else {
  // updated_at is left alone: the content has not changed, only its HTML.
  transaction(() => {
    for (const c of changes) run(`UPDATE ${c.table} SET ${c.htmlCol} = ? WHERE id = ?`, [c.html, c.id]);
  });
  console.log(`\nUpdated ${changes.length}.`);
}
