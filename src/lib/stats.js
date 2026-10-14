import crypto from 'node:crypto';
import config from '../config.js';
import { all, get, run, transaction } from '../db/index.js';
import { TZ } from './localtime.js';

/**
 * First-party visit counting.
 *
 * What it keeps: daily counters -- views per page, per referring site, per
 * device class -- and a rough count of different people per day. What it never
 * keeps: IP addresses, user agents, cookies, or a row per visit. "Different
 * people" comes from a keyed one-way fingerprint that lives only in memory and
 * changes every day, so nobody can be followed from one day to the next.
 *
 * Counts are held in memory and written once a minute, so a page view costs no
 * database write. A restart loses under a minute of counts, which is fine for
 * numbers that are approximate anyway (bots are filtered by a best guess).
 */

const FLUSH_EVERY_MS = 60 * 1000;
const MAX_PENDING = 5000;

const pageViews = new Map(); // JSON [day, audience, path, referrer, campaign, device] -> n
const seen = new Map(); // `${day}|${audience}` -> Set of fingerprints
const newVisitors = new Map(); // `${day}|${audience}` -> n not yet written
const extraEvents = new Map(); // JSON [day, name, detail] -> n

/* ------------------------------------------------------------- recognising */

const BOT =
  /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|uptime|headless|lighthouse|pingdom|curl|wget|python|java\/|go-http|axios|node-fetch|okhttp|libwww|httpclient|scrapy|ahrefs|semrush|mj12|dataforseo|petalbot|bytespider|ccbot|check_http|nagios|zabbix|statuscake|fly\.io|^$/i;

// Never counted: assets, health checks, sign-in and token pages, and the admin
// screens themselves (looking at the stats must not change them).
const SKIP_PATH =
  /^\/(assets|media|healthz|robots\.txt|sitemap\.xml|login|logout|logout-everywhere|forgot|reset|invite)(\/|$)|^\/members\/(admin|account)(\/|$)|\/(new|edit)$|\/updates\//;

export function dayOf(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function deviceOf(userAgent) {
  const ua = String(userAgent || '');
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(ua)) return 'phone';
  return 'desktop';
}

/** Referring site by name only ("facebook.com"); empty for direct or internal. */
export function referrerHost(referer, ownHost) {
  if (!referer) return '';
  try {
    const host = new URL(referer).hostname.replace(/^www\./, '').toLowerCase();
    const own = String(ownHost || '').replace(/^www\./, '').toLowerCase();
    if (!host || host === own) return '';
    return host.slice(0, 60);
  } catch {
    return '';
  }
}

export function campaignOf(query) {
  const raw = String(query?.src ?? query?.utm_source ?? '').toLowerCase();
  return /^[a-z0-9_-]{1,30}$/.test(raw) ? raw : '';
}

function fingerprint(day, ip, userAgent) {
  return crypto
    .createHmac('sha256', `${config.secrets.session}:${day}`)
    .update(`${ip}|${userAgent}`)
    .digest('base64url')
    .slice(0, 16);
}

/* --------------------------------------------------------------- collecting */

function bump(map, key, n = 1) {
  if (!map.has(key) && map.size >= MAX_PENDING) return;
  map.set(key, (map.get(key) ?? 0) + n);
}

/** Express middleware: counts a finished, successful HTML page view. */
export function statsMiddleware(req, res, next) {
  if (!config.stats.enabled || req.method !== 'GET') return next();
  // Taken here, before any router runs: inside a mounted router req.path is
  // relative to the mount point ("/stats" instead of "/members/admin/stats").
  const fullPath = req.path;
  res.on('finish', () => {
    try {
      count(req, res, fullPath);
    } catch (err) {
      console.warn('[stats] skipped a view:', err.message);
    }
  });
  return next();
}

/** A real person's request: not a bot, not a prefetch, and not opted out. */
export function humanRequest(req) {
  const ua = req.get('user-agent') ?? '';
  if (BOT.test(ua)) return false;
  if (/prefetch|prerender/i.test(`${req.get('sec-purpose') ?? ''} ${req.get('purpose') ?? ''}`)) return false;
  // Honour "do not track" and Global Privacy Control: count nothing at all.
  if (req.get('dnt') === '1' || req.get('sec-gpc') === '1') return false;
  return true;
}

function count(req, res, fullPath) {
  if (res.statusCode !== 200) return;
  if (!String(res.getHeader('content-type') ?? '').includes('text/html')) return;

  const path = (fullPath.replace(/\/+$/, '') || '/').toLowerCase().slice(0, 120);
  if (SKIP_PATH.test(path)) return;

  const ua = req.get('user-agent') ?? '';
  if (!humanRequest(req)) return;
  const dest = req.get('sec-fetch-dest');
  if (dest && dest !== 'document') return;

  const day = dayOf();
  const audience = req.user ? 'member' : 'visitor';
  const key = JSON.stringify([
    day,
    audience,
    path,
    referrerHost(req.get('referer'), req.hostname),
    campaignOf(req.query),
    deviceOf(ua),
  ]);
  bump(pageViews, key);

  const bucket = `${day}|${audience}`;
  const fp = fingerprint(day, req.ip, ua);
  let set = seen.get(bucket);
  if (!set) {
    set = new Set();
    seen.set(bucket, set);
  }
  if (!set.has(fp) && set.size < 100000) {
    set.add(fp);
    bump(newVisitors, bucket);
  }
  // Yesterday's fingerprints are of no further use.
  for (const k of seen.keys()) if (!k.startsWith(`${day}|`)) seen.delete(k);
}

/** Records something that is not a page view, e.g. recordEvent('calendar'). */
export function recordEvent(name, detail = '') {
  if (!config.stats.enabled) return;
  bump(extraEvents, JSON.stringify([dayOf(), String(name).slice(0, 40), String(detail).slice(0, 120)]));
}

/* ----------------------------------------------------------------- writing */

export function flushStats() {
  if (!pageViews.size && !newVisitors.size && !extraEvents.size) return 0;
  const views = [...pageViews];
  const visitors = [...newVisitors];
  const events = [...extraEvents];
  pageViews.clear();
  newVisitors.clear();
  extraEvents.clear();
  transaction(() => {
    views.forEach(([k, n]) => {
      const [day, audience, path, referrer, campaign, device] = JSON.parse(k);
      run(
        `INSERT INTO stats_daily (day, audience, path, referrer, campaign, device, views)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, audience, path, referrer, campaign, device)
         DO UPDATE SET views = views + excluded.views`,
        [day, audience, path, referrer, campaign, device, n]
      );
    });
    visitors.forEach(([bucket, n]) => {
      const [day, audience] = bucket.split('|');
      run(
        `INSERT INTO stats_visitors (day, audience, visitors) VALUES (?, ?, ?)
         ON CONFLICT(day, audience) DO UPDATE SET visitors = visitors + excluded.visitors`,
        [day, audience, n]
      );
    });
    events.forEach(([k, n]) => {
      const [day, name, detail] = JSON.parse(k);
      run(
        `INSERT INTO stats_events (day, name, detail, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, name, detail) DO UPDATE SET count = count + excluded.count`,
        [day, name, detail, n]
      );
    });
  });
  return views.length + visitors.length + events.length;
}

let timer = null;

export function startStats() {
  if (!config.stats.enabled || timer) return false;
  timer = setInterval(() => {
    try {
      flushStats();
    } catch (err) {
      console.error('[stats] flush failed:', err.message);
    }
  }, FLUSH_EVERY_MS);
  timer.unref();
  return true;
}

export function stopStats() {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    flushStats();
  } catch (err) {
    console.error('[stats] final flush failed:', err.message);
  }
}

/* --------------------------------------------------------------- reporting */

/** Chapter-time day strings for the last `days` days, oldest first. */
export function lastDays(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i -= 1) out.push(dayOf(new Date(now.getTime() - i * 86400000)));
  return out;
}

function sumBy(rows, field) {
  return rows.reduce((a, r) => a + (r[field] ?? 0), 0);
}

/** Pages that mean something to a person, from the path. */
export function classify(path) {
  let m;
  if ((m = path.match(/^\/events\/([a-z0-9-]+)$/)) && !['past', 'calendar.ics'].includes(m[1])) return { kind: 'event', key: m[1] };
  if ((m = path.match(/^\/builds\/([a-z0-9-]+)$/))) return { kind: 'build', key: m[1] };
  if ((m = path.match(/^\/members\/blog\/([a-z0-9-]+)$/))) return { kind: 'post', key: m[1] };
  if ((m = path.match(/^\/members\/locker\/(\d+)$/))) return { kind: 'tool', key: m[1] };
  return { kind: 'page', key: path };
}

const PAGE_NAMES = {
  '/': 'Welcome',
  '/about': 'About',
  '/events': 'Upcoming events',
  '/events/past': 'Past events',
  '/contact': 'Contact',
  '/join': 'Request an account',
  '/builds': "Members' builds",
  '/members': 'Members dashboard',
  '/members/blog': 'Blog (all posts)',
  '/members/builds': 'Your builds',
  '/members/locker': 'Tool Locker',
  '/members/locker/requests': 'Tool requests',
  '/members/directory': 'Member directory',
};

function titleLookup(kind, keys) {
  if (!keys.length) return {};
  const marks = keys.map(() => '?').join(',');
  const [sql] = {
    event: [`SELECT slug AS k, title AS t FROM events WHERE slug IN (${marks})`],
    build: [`SELECT slug AS k, title AS t FROM builds WHERE slug IN (${marks})`],
    post: [`SELECT slug AS k, title AS t FROM posts WHERE slug IN (${marks})`],
    tool: [`SELECT CAST(id AS TEXT) AS k, name AS t FROM tools WHERE CAST(id AS TEXT) IN (${marks})`],
  }[kind];
  return Object.fromEntries(all(sql, keys).map((r) => [r.k, r.t]));
}

/** Top items of one kind, with titles and a visitor/member split. */
function topOfKind(kind, since, limit = 8) {
  const rows = all(
    `SELECT path, audience, SUM(views) AS v FROM stats_daily WHERE day >= ? GROUP BY path, audience`,
    [since]
  );
  const items = new Map();
  for (const r of rows) {
    const c = classify(r.path);
    if (c.kind !== kind) continue;
    const it = items.get(c.key) ?? { key: c.key, path: r.path, visitors: 0, members: 0 };
    if (r.audience === 'member') it.members += r.v;
    else it.visitors += r.v;
    items.set(c.key, it);
  }
  const list = [...items.values()]
    .map((it) => ({ ...it, total: it.visitors + it.members }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
  const titles = titleLookup(kind, list.map((i) => i.key));
  return list.map((i) => ({ ...i, label: titles[i.key] ?? i.path }));
}

export function buildReport(days = 30, now = new Date()) {
  const dayList = lastDays(days, now);
  const since = dayList[0];

  const viewRows = all(
    `SELECT day, audience, SUM(views) AS v FROM stats_daily WHERE day >= ? GROUP BY day, audience`,
    [since]
  );
  const visitorRows = all('SELECT day, audience, visitors FROM stats_visitors WHERE day >= ?', [since]);
  const by = (rows, day, audience, field) =>
    rows.find((r) => r.day === day && r.audience === audience)?.[field] ?? 0;

  const daily = dayList.map((day) => ({
    day,
    visitorViews: by(viewRows, day, 'visitor', 'v'),
    memberViews: by(viewRows, day, 'member', 'v'),
  }));

  const visitorViews = sumBy(daily, 'visitorViews');
  const memberViews = sumBy(daily, 'memberViews');
  const visitorVisits = visitorRows.filter((r) => r.audience === 'visitor').reduce((a, r) => a + r.visitors, 0);
  const memberVisits = visitorRows.filter((r) => r.audience === 'member').reduce((a, r) => a + r.visitors, 0);

  const grouped = (sql, params = []) => all(sql, [since, ...params]);
  const pages = (audience, limit = 8) => {
    const rows = grouped(
      `SELECT path, SUM(views) AS v FROM stats_daily WHERE day >= ? AND audience = ? GROUP BY path ORDER BY v DESC`,
      [audience]
    );
    return rows
      .filter((r) => classify(r.path).kind === 'page')
      .slice(0, limit)
      .map((r) => ({ label: PAGE_NAMES[r.path] ?? r.path, value: r.v }));
  };

  const referrers = grouped(
    `SELECT referrer AS label, SUM(views) AS value FROM stats_daily
      WHERE day >= ? AND audience = 'visitor' AND referrer <> '' GROUP BY referrer ORDER BY value DESC LIMIT 8`
  );
  const directViews = grouped(
    `SELECT COALESCE(SUM(views), 0) AS n FROM stats_daily WHERE day >= ? AND audience = 'visitor' AND referrer = ''`
  )[0].n;
  const campaigns = grouped(
    `SELECT campaign AS label, SUM(views) AS value FROM stats_daily
      WHERE day >= ? AND campaign <> '' GROUP BY campaign ORDER BY value DESC LIMIT 8`
  );
  const devices = grouped(
    `SELECT device AS label, SUM(views) AS value FROM stats_daily
      WHERE day >= ? AND audience = 'visitor' GROUP BY device ORDER BY value DESC`
  );

  const eventCounts = Object.fromEntries(
    grouped('SELECT name, SUM(count) AS n FROM stats_events WHERE day >= ? GROUP BY name').map((r) => [r.name, r.n])
  );

  const sinceIso = new Date(now.getTime() - days * 86400000).toISOString();
  const messages = get('SELECT COUNT(*) AS n FROM contact_messages WHERE created_at >= ?', [sinceIso]).n;
  const applications = get('SELECT COUNT(*) AS n FROM membership_applications WHERE created_at >= ?', [sinceIso]).n;
  const toolRequests = get('SELECT COUNT(*) AS n FROM borrow_requests WHERE created_at >= ?', [sinceIso]).n;
  const logins = get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS people FROM audit_log
      WHERE action = 'auth.login.success' AND created_at >= ?`,
    [sinceIso]
  );
  const activeMembers = get('SELECT COUNT(*) AS n FROM users WHERE status = ?', ['active']).n;

  const pageViewsOf = (p) =>
    grouped("SELECT COALESCE(SUM(views), 0) AS n FROM stats_daily WHERE day >= ? AND audience = 'visitor' AND path = ?", [p])[0].n;

  return {
    days,
    since,
    daily,
    totals: { visitorViews, memberViews, visitorVisits, memberVisits },
    conversions: {
      contactViews: pageViewsOf('/contact'),
      joinViews: pageViewsOf('/join'),
      messages,
      applications,
      toolRequests,
      calendar: eventCounts.calendar ?? 0,
      listingClicks: eventCounts.listing ?? 0,
    },
    members: { logins: logins.n, loginPeople: logins.people, activeMembers },
    lists: {
      visitorPages: pages('visitor'),
      memberPages: pages('member'),
      events: topOfKind('event', since),
      builds: topOfKind('build', since),
      posts: topOfKind('post', since),
      tools: topOfKind('tool', since),
      referrers,
      directViews,
      campaigns,
      devices,
    },
  };
}
