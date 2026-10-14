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

const MAX_PEOPLE = 50000;

const pageViews = new Map(); // JSON [day, audience, path, referrer, campaign, device] -> n
const people = new Map(); // `${day}|${audience}|${fingerprint}` -> what that person has done today
const newVisitors = new Map(); // `${day}|${audience}` -> n not yet written
const extraEvents = new Map(); // JSON [day, audience, name, detail] -> n
const visitDeltas = new Map(); // JSON [day, audience, entry, referrer, campaign, device] -> { visits, engaged, acted, quiet }
const depthDeltas = new Map(); // JSON [day, audience, bucket] -> change in visits
const attentionDeltas = new Map(); // JSON [day, audience, path, secs, scroll] -> change in n
let peopleDay = '';

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

/** Who is looking: a signed-out visitor, a member, or an officer (admin or editor). */
export function audienceOf(req) {
  if (!req.user) return 'visitor';
  return ['admin', 'editor'].includes(req.user.role) ? 'staff' : 'member';
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

function bumpVisit(entry, field, n = 1) {
  const key = JSON.stringify(entry);
  if (!visitDeltas.has(key) && visitDeltas.size >= MAX_PENDING) return;
  const row = visitDeltas.get(key) ?? { visits: 0, engaged: 0, acted: 0, quiet: 0 };
  row[field] += n;
  visitDeltas.set(key, row);
}

function bumpDepth(day, audience, bucket, n) {
  bump(depthDeltas, JSON.stringify([day, audience, bucket]), n);
}

export function depthBucket(pages) {
  return pages <= 2 ? String(pages) : pages <= 5 ? '3-5' : '6+';
}

export function secsBucket(secs) {
  if (secs < 10) return '<10s';
  if (secs < 30) return '10-30s';
  if (secs < 60) return '30-60s';
  if (secs < 180) return '1-3m';
  return '3m+';
}

export function scrollBucket(pct) {
  if (pct < 25) return '<25%';
  if (pct < 50) return '25-50%';
  if (pct < 75) return '50-75%';
  return '75%+';
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
  const audience = audienceOf(req);
  const referrer = referrerHost(req.get('referer'), req.hostname);
  const campaign = campaignOf(req.query);
  const device = deviceOf(ua);
  bump(pageViews, JSON.stringify([day, audience, path, referrer, campaign, device]));

  // Yesterday's people are of no further use.
  if (peopleDay !== day) {
    people.clear();
    peopleDay = day;
  }
  const pkey = `${day}|${audience}|${fingerprint(day, req.ip, ua)}`;
  let who = people.get(pkey);
  if (!who) {
    if (people.size >= MAX_PEOPLE) return;
    who = { entry: [day, audience, path, referrer, campaign, device], pages: 0, acted: false, paths: new Set(), pings: new Map() };
    people.set(pkey, who);
    bump(newVisitors, `${day}|${audience}`);
    bumpVisit(who.entry, 'visits');
    bumpVisit(who.entry, 'quiet');
    bumpDepth(day, audience, '1', 1);
  }
  // Opening the same page again (a reload) is not a different page.
  if (who.paths.has(path)) return;
  who.pages += 1;
  if (who.paths.size < 40) who.paths.add(path);
  if (who.pages === 2) {
    bumpVisit(who.entry, 'engaged');
    if (!who.acted) bumpVisit(who.entry, 'quiet', -1);
  }
  if (who.pages === 2 || who.pages === 3 || who.pages === 6) {
    bumpDepth(day, audience, depthBucket(who.pages - 1), -1);
    bumpDepth(day, audience, depthBucket(who.pages), 1);
  }
}

/**
 * Notes that this person did something that counts as success (added the
 * calendar, asked for directions, followed a listing, sent a message). Only
 * affects today's tally for someone we have already seen look at a page.
 */
export function markAction(req) {
  if (!config.stats.enabled || !humanRequest(req)) return;
  const day = dayOf();
  const audience = audienceOf(req);
  const who = people.get(`${day}|${audience}|${fingerprint(day, req.ip, req.get('user-agent') ?? '')}`);
  if (!who || who.acted) return;
  who.acted = true;
  bumpVisit(who.entry, 'acted');
  if (who.pages === 1) bumpVisit(who.entry, 'quiet', -1);
}

/**
 * How long someone stayed and how far they scrolled, reported by the page. The
 * page may report several times (each time it is hidden), always with running
 * totals, so a repeat report replaces the last one rather than adding to it.
 * Accepted only for a page this person has already viewed today, which keeps
 * invented paths out of the tables.
 */
export function recordAttention(req, { id, path, secs, scroll }) {
  if (!config.stats.enabled || !humanRequest(req)) return false;
  const day = dayOf();
  const audience = audienceOf(req);
  const who = people.get(`${day}|${audience}|${fingerprint(day, req.ip, req.get('user-agent') ?? '')}`);
  const clean = String(path ?? '').replace(/\/+$/, '').toLowerCase() || '/';
  if (!who || !who.paths.has(clean)) return false;
  const t = Number(secs);
  const sc = Number(scroll);
  if (!Number.isFinite(t) || !Number.isFinite(sc) || t < 1) return false;
  const pingId = String(id ?? '').slice(0, 24) || clean;
  if (!who.pings.has(pingId) && who.pings.size >= 40) return false;
  const next = [secsBucket(Math.min(t, 3600)), scrollBucket(Math.min(Math.max(sc, 0), 100))];
  const prev = who.pings.get(pingId);
  if (prev && prev[0] === next[0] && prev[1] === next[1]) return true;
  if (prev) bump(attentionDeltas, JSON.stringify([day, audience, clean, ...prev]), -1);
  bump(attentionDeltas, JSON.stringify([day, audience, clean, ...next]), 1);
  who.pings.set(pingId, next);
  return true;
}

/** Records something that is not a page view, e.g. recordEvent('calendar'). */
export function recordEvent(name, detail = '', req = null) {
  if (!config.stats.enabled) return;
  const audience = req ? audienceOf(req) : 'visitor';
  bump(extraEvents, JSON.stringify([dayOf(), audience, String(name).slice(0, 40), String(detail).slice(0, 120)]));
  if (req) markAction(req);
}

/* ----------------------------------------------------------------- writing */

export function flushStats() {
  if (
    !pageViews.size &&
    !newVisitors.size &&
    !extraEvents.size &&
    !visitDeltas.size &&
    !depthDeltas.size &&
    !attentionDeltas.size
  ) {
    return 0;
  }
  const views = [...pageViews];
  const visitors = [...newVisitors];
  const events = [...extraEvents];
  const visits = [...visitDeltas];
  const depth = [...depthDeltas];
  const attention = [...attentionDeltas];
  pageViews.clear();
  newVisitors.clear();
  extraEvents.clear();
  visitDeltas.clear();
  depthDeltas.clear();
  attentionDeltas.clear();
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
      const [day, audience, name, detail] = JSON.parse(k);
      run(
        `INSERT INTO stats_events (day, audience, name, detail, count) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, audience, name, detail) DO UPDATE SET count = count + excluded.count`,
        [day, audience, name, detail, n]
      );
    });
    visits.forEach(([k, d]) => {
      const [day, audience, entry, referrer, campaign, device] = JSON.parse(k);
      run(
        `INSERT INTO stats_visits (day, audience, entry_path, referrer, campaign, device, visits, engaged, acted, quiet)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, audience, entry_path, referrer, campaign, device) DO UPDATE SET
           visits = visits + excluded.visits, engaged = engaged + excluded.engaged,
           acted = acted + excluded.acted, quiet = quiet + excluded.quiet`,
        [day, audience, entry, referrer, campaign, device, d.visits, d.engaged, d.acted, d.quiet]
      );
    });
    depth.forEach(([k, n]) => {
      const [day, audience, bucket] = JSON.parse(k);
      run(
        `INSERT INTO stats_depth (day, audience, bucket, visits) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, audience, bucket) DO UPDATE SET visits = visits + excluded.visits`,
        [day, audience, bucket, n]
      );
    });
    attention.forEach(([k, n]) => {
      const [day, audience, path, secs, scroll] = JSON.parse(k);
      run(
        `INSERT INTO stats_attention (day, audience, path, secs, scroll, n) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, audience, path, secs, scroll) DO UPDATE SET n = n + excluded.n`,
        [day, audience, path, secs, scroll, n]
      );
    });
  });
  return views.length + visitors.length + events.length + visits.length + depth.length + attention.length;
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
    else if (r.audience === 'visitor') it.visitors += r.v;
    else continue; // officers' own looking around is kept out of the rankings
    items.set(c.key, it);
  }
  const list = [...items.values()]
    .map((it) => ({ ...it, total: it.visitors + it.members }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
  const titles = titleLookup(kind, list.map((i) => i.key));
  return list.map((i) => ({ ...i, label: titles[i.key] ?? i.path }));
}

/** Readable names for a list of paths: page names, or the title of the event, build, post or tool. */
function labelPaths(paths) {
  const unique = [...new Set(paths)];
  const byKind = { event: [], build: [], post: [], tool: [] };
  for (const p of unique) {
    const c = classify(p);
    if (byKind[c.kind]) byKind[c.kind].push(c.key);
  }
  const titles = Object.fromEntries(Object.entries(byKind).map(([k, keys]) => [k, titleLookup(k, keys)]));
  const out = {};
  for (const p of unique) {
    const c = classify(p);
    out[p] = c.kind === 'page' ? PAGE_NAMES[p] ?? p : titles[c.kind]?.[c.key] ?? p;
  }
  return out;
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
  const staffViews = viewRows.filter((r) => r.audience === 'staff').reduce((a, r) => a + r.v, 0);
  const staffVisits = visitorRows.filter((r) => r.audience === 'staff').reduce((a, r) => a + r.visitors, 0);
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
      WHERE day >= ? AND audience = 'visitor' AND campaign <> '' GROUP BY campaign ORDER BY value DESC LIMIT 8`
  );
  const devices = grouped(
    `SELECT device AS label, SUM(views) AS value FROM stats_daily
      WHERE day >= ? AND audience = 'visitor' GROUP BY device ORDER BY value DESC`
  );

  const eventCounts = Object.fromEntries(
    grouped("SELECT name, SUM(count) AS n FROM stats_events WHERE day >= ? AND audience = 'visitor' GROUP BY name").map((r) => [r.name, r.n])
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

  // Engagement: did people stay, and did they do anything?
  const visitSums = (audience) =>
    all(
      `SELECT COALESCE(SUM(visits),0) AS visits, COALESCE(SUM(engaged),0) AS engaged,
              COALESCE(SUM(acted),0) AS acted, COALESCE(SUM(quiet),0) AS quiet
         FROM stats_visits WHERE day >= ? AND audience = ?`,
      [since, audience]
    )[0];
  const depthOf = (audience) => {
    const rows = all('SELECT bucket, SUM(visits) AS n FROM stats_depth WHERE day >= ? AND audience = ? GROUP BY bucket', [since, audience]);
    return ['1', '2', '3-5', '6+'].map((b) => ({
      label: b === '1' ? '1 page' : `${b} pages`,
      value: Math.max(0, rows.find((r) => r.bucket === b)?.n ?? 0),
    }));
  };
  const landingRows = (audience) =>
    all(
      `SELECT entry_path AS path, SUM(visits) AS visits, SUM(engaged) AS engaged, SUM(acted) AS acted, SUM(quiet) AS quiet
         FROM stats_visits WHERE day >= ? AND audience = ? GROUP BY entry_path HAVING SUM(visits) > 0
        ORDER BY visits DESC LIMIT 8`,
      [since, audience]
    );
  const sourceRows = all(
    `SELECT CASE WHEN campaign <> '' THEN 'tag: ' || campaign WHEN referrer <> '' THEN referrer ELSE 'Direct or unknown' END AS label,
            SUM(visits) AS visits, SUM(engaged) AS engaged, SUM(acted) AS acted, SUM(quiet) AS quiet
       FROM stats_visits WHERE day >= ? AND audience = 'visitor' GROUP BY label HAVING SUM(visits) > 0
      ORDER BY visits DESC LIMIT 8`,
    [since]
  );
  const attentionRows = all(
    `SELECT path, secs, scroll, SUM(n) AS n FROM stats_attention WHERE day >= ? AND audience <> 'staff' GROUP BY path, secs, scroll HAVING SUM(n) > 0`,
    [since]
  );
  const landings = landingRows('visitor');
  const memberLanding = landingRows('member');
  const labels = labelPaths([
    ...landings.map((r) => r.path),
    ...memberLanding.map((r) => r.path),
    ...attentionRows.map((r) => r.path),
  ]);
  const ratesOf = (r) => ({
    ...r,
    label: r.label ?? labels[r.path] ?? r.path,
    enough: r.visits >= 5,
    stayedPct: r.visits ? Math.round((r.engaged / r.visits) * 100) : 0,
    actedPct: r.visits ? Math.round((r.acted / r.visits) * 100) : 0,
    quietPct: r.visits ? Math.round((r.quiet / r.visits) * 100) : 0,
  });
  const SECS = ['<10s', '10-30s', '30-60s', '1-3m', '3m+'];
  const byPath = new Map();
  for (const r of attentionRows) {
    const it = byPath.get(r.path) ?? { path: r.path, n: 0, secs: {}, deep: 0 };
    it.n += r.n;
    it.secs[r.secs] = (it.secs[r.secs] ?? 0) + r.n;
    if (r.scroll === '75%+') it.deep += r.n;
    byPath.set(r.path, it);
  }
  const attention = [...byPath.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 10)
    .map((it) => {
      let run = 0;
      let typical = '';
      for (const b of SECS) {
        run += it.secs[b] ?? 0;
        if (!typical && run >= it.n / 2) typical = b;
      }
      return {
        path: it.path,
        label: labels[it.path] ?? it.path,
        n: it.n,
        enough: it.n >= 5,
        typical,
        deepPct: Math.round((it.deep / it.n) * 100),
      };
    });

  const sinceMs = (d) => new Date(now.getTime() - d * 86400000).toISOString();
  const memberActivity = {
    active: activeMembers,
    last7: get("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND last_login_at >= ?", [sinceMs(7)]).n,
    last30: get("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND last_login_at >= ?", [sinceMs(30)]).n,
    never: get("SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND last_login_at IS NULL").n,
    quiet60: get(
      "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND last_login_at IS NOT NULL AND last_login_at < ?",
      [sinceMs(60)]
    ).n,
  };

  const pageViewsOf = (p) =>
    grouped("SELECT COALESCE(SUM(views), 0) AS n FROM stats_daily WHERE day >= ? AND audience = 'visitor' AND path = ?", [p])[0].n;

  return {
    days,
    since,
    daily,
    totals: { visitorViews, memberViews, visitorVisits, memberVisits, staffViews, staffVisits },
    conversions: {
      contactViews: pageViewsOf('/contact'),
      joinViews: pageViewsOf('/join'),
      messages,
      applications,
      toolRequests,
      calendar: eventCounts.calendar ?? 0,
      listingClicks: eventCounts.listing ?? 0,
      directions: eventCounts.directions ?? 0,
    },
    members: { logins: logins.n, loginPeople: logins.people, activeMembers, ...memberActivity },
    engagement: {
      visitor: ratesOf({ ...visitSums('visitor'), label: 'All visitors' }),
      member: ratesOf({ ...visitSums('member'), label: 'All members' }),
      staff: ratesOf({ ...visitSums('staff'), label: 'Officers' }),
      visitorDepth: depthOf('visitor'),
      memberDepth: depthOf('member'),
      landings: landings.map(ratesOf),
      memberLandings: memberLanding.map(ratesOf),
      sources: sourceRows.map(ratesOf),
      attention,
    },
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

/**
 * POST /stats/ping handler. Always answers 204 and says nothing about why a
 * report was ignored. The body is a tiny JSON string sent with sendBeacon.
 */
export function pingHandler(req, res) {
  res.status(204).end();
  try {
    if (typeof req.body !== 'string' || req.body.length > 300) return;
    const site = req.get('sec-fetch-site');
    if (site && site !== 'same-origin') return; // only our own pages report
    const data = JSON.parse(req.body);
    const path = typeof data.p === 'string' ? data.p : '';
    if (!/^\/[a-z0-9/._-]{0,119}$/i.test(path) || SKIP_PATH.test(path.toLowerCase())) return;
    recordAttention(req, { id: data.i, path, secs: data.t, scroll: data.s });
  } catch {
    /* malformed report: ignore */
  }
}
