import session from 'express-session';
import { all, get, run } from '../db/index.js';

const Store = session.Store;

/**
 * SQLite-backed session store.
 *
 * Sessions live server-side; the browser only ever holds an opaque, signed,
 * httpOnly session id. That means we can revoke a session instantly (logout
 * everywhere, forced logout after a password reset) and no session payload is
 * ever exposed to client-side JavaScript.
 */
export class SqliteSessionStore extends Store {
  constructor({ pruneIntervalMs = 10 * 60 * 1000 } = {}) {
    super();
    this.prune();
    this.timer = setInterval(() => this.prune(), pruneIntervalMs);
    this.timer.unref?.();
  }

  prune() {
    try {
      run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
    } catch {
      /* pruning is best-effort */
    }
  }

  #expiry(sess) {
    const ttl = sess?.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess?.cookie?.originalMaxAge ?? 3600_000);
    return Math.floor(ttl);
  }

  get(sid, cb) {
    try {
      const row = get('SELECT data, expires_at FROM sessions WHERE sid = ?', [sid]);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        run('DELETE FROM sessions WHERE sid = ?', [sid]);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      run(
        `INSERT INTO sessions (sid, user_id, data, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET
           user_id    = excluded.user_id,
           data       = excluded.data,
           expires_at = excluded.expires_at`,
        [sid, sess?.userId ?? null, JSON.stringify(sess), this.#expiry(sess)]
      );
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [this.#expiry(sess), sid]);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      run('DELETE FROM sessions WHERE sid = ?', [sid]);
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }

  length(cb) {
    try {
      const row = get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', [Date.now()]);
      return cb(null, row.n);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb) {
    try {
      run('DELETE FROM sessions');
      return cb(null);
    } catch (err) {
      return cb(err);
    }
  }
}

/** Revokes every session for a user -- used after a password reset or suspension. */
export function destroyUserSessions(userId, { except = null } = {}) {
  if (except) {
    run('DELETE FROM sessions WHERE user_id = ? AND sid <> ?', [userId, except]);
  } else {
    run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

export function listUserSessions(userId) {
  return all(
    'SELECT sid, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY expires_at DESC',
    [userId, Date.now()]
  );
}
