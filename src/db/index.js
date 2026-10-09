import fs from 'node:fs';
import path from 'node:path';
/**
 * `node:sqlite` is only importable without a flag from Node 23.4 onwards; on
 * 22.x it needs --experimental-sqlite and otherwise throws something obscure.
 * Cloud buildpacks pick the lowest version that satisfies `engines`, so this
 * check turns a confusing boot crash into a sentence that says what to do.
 */
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (err) {
  throw new Error(
    `This app needs Node 23.4 or newer for its built-in SQLite support ` +
      `(running ${process.version}). Original error: ${err.message}`
  );
}
import config from '../config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new DatabaseSync(config.dbFile);

// WAL keeps readers from blocking on the writer; foreign keys are off by
// default in SQLite and we rely on them for cascade deletes.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

/**
 * Every query in this codebase goes through these helpers with bound
 * parameters. There is no string interpolation of user input into SQL
 * anywhere -- that is the whole injection defence.
 */
export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export default db;
