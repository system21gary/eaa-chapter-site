import { all } from '../db/index.js';

/**
 * Suggestions for free-text fields, so people reuse "Hangar 6" instead of
 * inventing "hangar six". Values come from what is already stored, most used
 * first; spellings that differ only by case are collapsed to the commonest.
 *
 * Table and column names come from the routes' own maps, never from a request.
 */
function distinctValues(table, column) {
  const rows = all(
    `SELECT ${column} AS v, COUNT(*) AS n
       FROM ${table}
      WHERE ${column} IS NOT NULL AND TRIM(${column}) <> ''
      GROUP BY ${column}
      ORDER BY n DESC, ${column} COLLATE NOCASE
      LIMIT 200`
  );
  const seen = new Set();
  const out = [];
  for (const { v } of rows) {
    const key = v.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
    if (out.length === 60) break;
  }
  return out;
}

/**
 * Express middleware: exposes `{ name: [table, column] }` to templates as lists
 * of suggestions. They are getters, so the query only runs on pages that
 * actually use the list.
 */
export function suggestLocals(map) {
  return (req, res, next) => {
    for (const [name, [table, column]] of Object.entries(map)) {
      Object.defineProperty(res.locals, name, {
        get: () => distinctValues(table, column),
        enumerable: true,
        configurable: true,
      });
    }
    next();
  };
}
