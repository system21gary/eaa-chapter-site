import { all, get, run, nowIso } from '../db/index.js';
import { renderMarkdown } from '../lib/markdown.js';
import { slugify } from '../lib/validate.js';

const EVENT_COLUMNS = `
  id, slug, title, summary, starts_at, ends_at, all_day, rain_date,
  location_name, address, city, state, zip, latitude, longitude, cost,
  contact_name, contact_email, contact_phone, external_url, poster_path,
  poster_alt, kind, status, attendance, created_at, updated_at
`;

function uniqueSlug(title, startsAt, excludeId = null) {
  const year = startsAt ? new Date(startsAt).getUTCFullYear() : new Date().getUTCFullYear();
  const base = `${slugify(title, { maxLength: 60 })}-${year}`;
  let candidate = base;
  let n = 2;
  for (;;) {
    if (!get('SELECT id FROM events WHERE slug = ? AND id IS NOT ?', [candidate, excludeId])) {
      return candidate;
    }
    candidate = `${base}-${n++}`;
  }
}

/**
 * "Upcoming" means the event has not finished yet -- an all-day fly-in still
 * counts as upcoming at 10am on the day, which is exactly when people check.
 */
export function upcomingEvents({ limit = 25, includeDrafts = false } = {}) {
  return all(
    `SELECT ${EVENT_COLUMNS},
            (SELECT COUNT(*) FROM event_photos ep WHERE ep.event_id = events.id) AS photo_count
       FROM events
      WHERE COALESCE(ends_at, starts_at) >= ?
        AND status IN (${includeDrafts ? "'published','draft','cancelled'" : "'published','cancelled'"})
      ORDER BY starts_at ASC
      LIMIT ?`,
    [nowIso(), Math.min(Number(limit) || 25, 100)]
  );
}

export function pastEvents({ limit = 30, offset = 0, year = null, includeDrafts = false } = {}) {
  const params = [nowIso()];
  let yearClause = '';
  if (year) {
    yearClause = "AND strftime('%Y', starts_at) = ?";
    params.push(String(year));
  }
  params.push(Math.min(Number(limit) || 30, 100), Math.max(Number(offset) || 0, 0));

  return all(
    `SELECT ${EVENT_COLUMNS},
            (SELECT COUNT(*) FROM event_photos ep WHERE ep.event_id = events.id) AS photo_count,
            -- Full size, not the thumbnail: the card crops to 16:9 and a
            -- square "attention" thumb would leave nothing but sky.
            (SELECT full_path FROM event_photos ep WHERE ep.event_id = events.id ORDER BY ep.sort, ep.id LIMIT 1) AS first_photo
       FROM events
      WHERE COALESCE(ends_at, starts_at) < ?
        AND status IN (${includeDrafts ? "'published','draft','cancelled'" : "'published','cancelled'"})
        ${yearClause}
      ORDER BY starts_at DESC
      LIMIT ? OFFSET ?`,
    params
  );
}

export function pastEventYears() {
  return all(
    `SELECT DISTINCT strftime('%Y', starts_at) AS year
       FROM events
      WHERE COALESCE(ends_at, starts_at) < ? AND status = 'published'
      ORDER BY year DESC`,
    [nowIso()]
  ).map((r) => r.year);
}

export function getEventBySlug(slug, { viewer = null } = {}) {
  const event = get('SELECT * FROM events WHERE slug = ?', [slug]);
  if (!event) return null;
  const isStaff = viewer && (viewer.role === 'editor' || viewer.role === 'admin');
  if (event.status === 'draft' && !isStaff) return null;
  event.photos = all(
    'SELECT id, full_path, thumb_path, caption, credit FROM event_photos WHERE event_id = ? ORDER BY sort, id',
    [event.id]
  );
  return event;
}

export function getEventById(id) {
  return get('SELECT * FROM events WHERE id = ?', [Number(id)]) ?? null;
}

export function nextEvent() {
  return (
    get(
      `SELECT ${EVENT_COLUMNS} FROM events
        WHERE COALESCE(ends_at, starts_at) >= ? AND status = 'published'
        ORDER BY starts_at ASC LIMIT 1`,
      [nowIso()]
    ) ?? null
  );
}

export function saveEvent(fields, id = null) {
  const ts = nowIso();
  const bodyHtml = fields.bodyMd ? renderMarkdown(fields.bodyMd) : null;
  const recapHtml = fields.recapMd ? renderMarkdown(fields.recapMd) : null;

  if (id) {
    const existing = getEventById(id);
    run(
      `UPDATE events SET
         title = ?, slug = ?, summary = ?, body_md = ?, body_html = ?,
         starts_at = ?, ends_at = ?, all_day = ?, rain_date = ?,
         location_name = ?, address = ?, city = ?, state = ?, zip = ?,
         latitude = ?, longitude = ?, cost = ?, contact_name = ?,
         contact_email = ?, contact_phone = ?, external_url = ?,
         poster_path = ?, poster_alt = ?, kind = ?, status = ?,
         recap_md = ?, recap_html = ?, attendance = ?, updated_at = ?
       WHERE id = ?`,
      [
        fields.title,
        fields.title !== existing.title ? uniqueSlug(fields.title, fields.startsAt, id) : existing.slug,
        fields.summary,
        fields.bodyMd,
        bodyHtml,
        fields.startsAt,
        fields.endsAt,
        fields.allDay ? 1 : 0,
        fields.rainDate,
        fields.locationName,
        fields.address,
        fields.city,
        fields.state,
        fields.zip,
        fields.latitude,
        fields.longitude,
        fields.cost,
        fields.contactName,
        fields.contactEmail,
        fields.contactPhone,
        fields.externalUrl,
        'posterPath' in fields ? fields.posterPath : existing.poster_path,
        fields.posterAlt,
        fields.kind,
        fields.status,
        fields.recapMd,
        recapHtml,
        fields.attendance,
        ts,
        Number(id),
      ]
    );
    return Number(id);
  }

  const info = run(
    `INSERT INTO events
       (slug, title, summary, body_md, body_html, starts_at, ends_at, all_day,
        rain_date, location_name, address, city, state, zip, latitude, longitude,
        cost, contact_name, contact_email, contact_phone, external_url,
        poster_path, poster_alt, kind, status, recap_md, recap_html, attendance,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uniqueSlug(fields.title, fields.startsAt),
      fields.title,
      fields.summary,
      fields.bodyMd,
      bodyHtml,
      fields.startsAt,
      fields.endsAt,
      fields.allDay ? 1 : 0,
      fields.rainDate,
      fields.locationName,
      fields.address,
      fields.city,
      fields.state,
      fields.zip,
      fields.latitude,
      fields.longitude,
      fields.cost,
      fields.contactName,
      fields.contactEmail,
      fields.contactPhone,
      fields.externalUrl,
      fields.posterPath ?? null,
      fields.posterAlt ?? null,
      fields.kind,
      fields.status,
      fields.recapMd ?? null,
      recapHtml,
      fields.attendance ?? null,
      ts,
      ts,
    ]
  );
  return Number(info.lastInsertRowid);
}

export function deleteEvent(id) {
  const photos = all('SELECT full_path, thumb_path FROM event_photos WHERE event_id = ?', [
    Number(id),
  ]);
  run('DELETE FROM events WHERE id = ?', [Number(id)]);
  return photos;
}

export function addPhoto(eventId, { fullPath, thumbPath, caption = null, credit = null }) {
  const next = get('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM event_photos WHERE event_id = ?', [
    Number(eventId),
  ]).s;
  const info = run(
    `INSERT INTO event_photos (event_id, full_path, thumb_path, caption, credit, sort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [Number(eventId), fullPath, thumbPath, caption, credit, next, nowIso()]
  );
  return Number(info.lastInsertRowid);
}

export function getPhoto(id) {
  return get('SELECT * FROM event_photos WHERE id = ?', [Number(id)]) ?? null;
}

export function deletePhoto(id) {
  run('DELETE FROM event_photos WHERE id = ?', [Number(id)]);
}

/** iCalendar feed so members can subscribe from ForeFlight, Google, Outlook. */
export function toIcs(events, { baseUrl }) {
  const fold = (line) => line.match(/.{1,73}/g).join('\r\n ');
  const esc = (s) =>
    String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EAA Chapter 1699//Website//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:EAA Chapter 1699',
  ];

  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:event-${e.id}@eaa1699.org`,
      `DTSTAMP:${stamp(e.updated_at || e.created_at || new Date().toISOString())}`,
      `DTSTART:${stamp(e.starts_at)}`,
      e.ends_at ? `DTEND:${stamp(e.ends_at)}` : null,
      fold(`SUMMARY:${esc(e.title)}`),
      e.summary ? fold(`DESCRIPTION:${esc(e.summary)}`) : null,
      e.location_name
        ? fold(`LOCATION:${esc([e.location_name, e.city, e.state].filter(Boolean).join(', '))}`)
        : null,
      `URL:${baseUrl}/events/${e.slug}`,
      e.status === 'cancelled' ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}
