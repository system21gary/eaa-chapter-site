import nunjucks from 'nunjucks';

import config from '../config.js';
import { withBase, absoluteUrl } from '../middleware/base-path.js';
import { renderMarkdown, excerpt } from '../lib/markdown.js';

import { TZ, toLocalInput, toLocalDateInput } from '../lib/localtime.js';

function fmt(value, options) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...options }).format(d);
}

export function registerFilters(env) {
  // "Saturday, May 30, 2026"
  env.addFilter('date', (v) =>
    fmt(v, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  );
  // "May 30, 2026"
  env.addFilter('shortdate', (v) => fmt(v, { month: 'short', day: 'numeric', year: 'numeric' }));
  // "9:00 AM"
  env.addFilter('time', (v) => fmt(v, { hour: 'numeric', minute: '2-digit' }));
  env.addFilter('datetime', (v) =>
    fmt(v, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  );
  env.addFilter('month', (v) => fmt(v, { month: 'short' }));
  env.addFilter('day', (v) => fmt(v, { day: 'numeric' }));
  env.addFilter('year', (v) => fmt(v, { year: 'numeric' }));
  env.addFilter('isodate', (v) => (v ? new Date(v).toISOString() : ''));
  // Values for date and datetime-local inputs, in chapter time, so a form
  // shows what was typed into it rather than the stored UTC.
  env.addFilter('localinput', (v) => toLocalInput(v));
  env.addFilter('localdate', (v) => toLocalDateInput(v));

  /** "9:00 AM – 12:00 PM" or "All day" */
  env.addFilter('timerange', (start, end, allDay) => {
    if (allDay) return 'All day';
    if (!end) return fmt(start, { hour: 'numeric', minute: '2-digit' });
    return `${fmt(start, { hour: 'numeric', minute: '2-digit' })} – ${fmt(end, {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    })}`;
  });

  /** "3 days ago" / "in 2 weeks" */
  env.addFilter('relative', (v) => {
    if (!v) return '';
    const diff = new Date(v).getTime() - Date.now();
    const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
    const units = [
      ['year', 31536000000],
      ['month', 2592000000],
      ['week', 604800000],
      ['day', 86400000],
      ['hour', 3600000],
      ['minute', 60000],
    ];
    for (const [unit, ms] of units) {
      if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
    }
    return 'just now';
  });

  /** Days until an event, for the countdown chip on the home page. */
  env.addFilter('daysuntil', (v) => {
    if (!v) return null;
    const days = Math.ceil((new Date(v).getTime() - Date.now()) / 86400000);
    return days;
  });

  env.addFilter('phone', (v) => {
    const d = String(v ?? '').replace(/\D/g, '');
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    return v ?? '';
  });

  /**
   * Every internal URL goes through here, so the site works both at a domain
   * root and under a path prefix (see middleware/base-path.js).
   */
  env.addFilter('url', (p) => withBase(p));

  /**
   * Markdown -> sanitised HTML, for fields rendered at display time rather
   * than cached in a *_html column. Same allow-list as everything else.
   */
  env.addFilter('markdown', (md) => new nunjucks.runtime.SafeString(renderMarkdown(md)));

  /** Markdown -> plain text, for card blurbs where markup would show through. */
  env.addFilter('plain', (md) => excerpt(md, 100000));

  /** Serves an uploaded image through the controlled media route. */
  env.addFilter('media', (relPath) => (relPath ? withBase(`/media/${relPath}`) : ''));

  // Works for a user row or any joined row that carries an author_/owner_/req_
  // prefixed name, so one filter covers every avatar fallback on the site.
  env.addFilter('initials', (row) => {
    if (!row) return '?';
    const first =
      row.first_name || row.author_first || row.owner_first || row.req_first || '';
    const last = row.last_name || row.author_last || row.owner_last || row.req_last || '';
    return `${first[0] ?? '?'}${last[0] ?? ''}`.toUpperCase();
  });

  env.addFilter('truncate', (text, len = 160) => {
    const s = String(text ?? '');
    if (s.length <= len) return s;
    return `${s.slice(0, s.lastIndexOf(' ', len) || len)}…`;
  });

  /** Static asset URL with a cache-busting build stamp. */
  const buildId = process.env.BUILD_ID || String(Date.now());
  env.addFilter('asset', (p) => withBase(`/assets/${String(p).replace(/^\//, '')}?v=${buildId}`));

  env.addFilter('absolute', (p) => absoluteUrl(p));

  /** Google Maps link built from coordinates we control, never user input. */
  env.addFilter('maplink', (obj) => {
    const lat = Number(obj?.latitude);
    const lon = Number(obj?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  });

  env.addGlobal('now', () => new Date().toISOString());
  env.addGlobal('currentYear', new Date().getFullYear());

  /**
   * Inline SVG icons.
   *
   * These used to be emoji. Emoji depend on the reader having a colour emoji
   * font installed -- most phones and desktops do, but plenty of Linux
   * machines, older Windows installs and PDF renderers do not, and there the
   * glyph comes out as an empty box. Inline SVG renders identically
   * everywhere, prints properly, and takes its colour from the surrounding
   * text.
   */
  const ICONS = {
    // The chapter mark; the general-purpose decoration for empty states.
    mark: '<circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/><path d="M24 11 L28.4 21.6 L40 24 L28.4 26.4 L24 37 L19.6 26.4 L8 24 L19.6 21.6 Z" fill="currentColor"/>',
    plane:
      '<path d="M6 27 L42 21 a3 3 0 0 1 0 6 L30 29 l-6 11 h-4 l3.5-11 -8 0 -3 4 h-3 l2-7 -2-7 h3 l3 4 8 0 -3.5-11 h4 l6 11" fill="currentColor"/>',
    tools:
      '<path d="M10 34 L26 18 a8 8 0 0 1 10-10 l-5 5 4 4 5-5a8 8 0 0 1-10 10 L14 38 a3 3 0 0 1-4-4z" fill="currentColor"/><rect x="8" y="8" width="6" height="14" rx="2" fill="currentColor" opacity=".55"/>',
    calendar:
      '<rect x="8" y="12" width="32" height="28" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M8 21 h32" stroke="currentColor" stroke-width="3"/><path d="M16 8 v8 M32 8 v8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    photo:
      '<rect x="6" y="13" width="36" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="26" r="7" fill="none" stroke="currentColor" stroke-width="3"/><path d="M17 13 l3-4 h8 l3 4" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
    mail:
      '<rect x="6" y="11" width="36" height="26" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M7 14 L24 27 L41 14" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
    pen:
      '<path d="M9 39 l2-8 21-21 6 6 -21 21z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><path d="M29 13 l6 6" stroke="currentColor" stroke-width="3"/>',
    people:
      '<circle cx="18" cy="18" r="7" fill="none" stroke="currentColor" stroke-width="3"/><path d="M7 39 a11 11 0 0 1 22 0" fill="none" stroke="currentColor" stroke-width="3"/><path d="M31 12 a7 7 0 0 1 0 13 M33 30 a11 11 0 0 1 8 9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    doc:
      '<path d="M12 6 h16 l8 8 v28 a2 2 0 0 1-2 2 H12 a2 2 0 0 1-2-2 V8 a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="3"/><path d="M28 6 v9 h8 M17 26 h14 M17 33 h14" fill="none" stroke="currentColor" stroke-width="3"/>',
    compass:
      '<circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="3"/><path d="M31 17 l-4 10 -10 4 4-10z" fill="currentColor"/>',
    lock:
      '<rect x="11" y="21" width="26" height="19" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><path d="M17 21 v-5 a7 7 0 0 1 14 0 v5" fill="none" stroke="currentColor" stroke-width="3"/>',
    clock:
      '<circle cx="24" cy="24" r="18" fill="none" stroke="currentColor" stroke-width="3"/><path d="M24 13 v12 l8 5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    wrench:
      '<path d="M33 8 a11 11 0 0 0-13 14 L8 34 a4 4 0 0 0 6 6 l12-12 a11 11 0 0 0 14-13 l-7 7 -6-6z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/>',
    check: '<path d="M11 25 l9 9 17-19" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
    pin:
      '<path d="M24 6 a13 13 0 0 1 13 13 c0 10-13 23-13 23 S11 29 11 19 A13 13 0 0 1 24 6z" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="24" cy="19" r="5" fill="currentColor"/>',
    landing:
      '<path d="M6 38 h36" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M9 30 L38 22 a3 3 0 0 0-1.5-5.8 L26 19 L16 9 l-4 1 5 12 -7 2 -4-4 -3 1 3 8z" fill="currentColor"/>',
    applause:
      '<path d="M18 40 a10 10 0 0 1-8-9 l-1-9 a2.5 2.5 0 0 1 5-.6 l1 6 1-14 a2.5 2.5 0 0 1 5 0 l.5 12 1-15 a2.5 2.5 0 0 1 5 0 l-.5 15 2-11 a2.5 2.5 0 0 1 5 .8 l-2 16 a11 11 0 0 1-9 9z" fill="currentColor"/>',
  };

  env.addGlobal('icon', (name, size = 48) => {
    const path = ICONS[name] ?? ICONS.mark;
    return new nunjucks.runtime.SafeString(
      `<svg viewBox="0 0 48 48" width="${size}" height="${size}" fill="none" ` +
        `aria-hidden="true" focusable="false" class="icon-svg">${path}</svg>`
    );
  });
}
