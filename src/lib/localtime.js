import config from '../config.js';

/**
 * Chapter time.
 *
 * The site is local: when an officer types 7:00 PM into the event form, 7:00 PM
 * in Selkirk is what they mean, and 7:00 PM is what every page should show.
 * A browser's date and datetime-local inputs send wall-clock text with no
 * zone ("2026-10-15T19:00"), and `new Date()` would read that in the server's
 * zone -- UTC on Fly -- turning 7 PM into 3 PM Eastern.
 *
 * So the rule is: text from a form is chapter time; values in the database
 * are exact moments (ISO, UTC), which keeps sorting, "upcoming vs past" and
 * the calendar feed correct; and anything shown or put back into a form is
 * converted to chapter time on the way out. Nothing here depends on the
 * server's own time zone.
 */
export const TZ = config.site.timeZone;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The wall-clock fields of an instant, in chapter time. */
function wallClock(date) {
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** How far chapter time is ahead of UTC at an instant, in ms (negative here). */
function offsetAt(ms) {
  const w = wallClock(new Date(ms));
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the chapter's clocks read the given wall time.
 *
 * Daylight saving makes two edge cases. In spring a wall time that never
 * happened (2:30 AM on the changeover night) moves forward an hour, as a
 * clock would. In autumn a wall time that happens twice (1:30 AM) resolves
 * to the first, still-daylight one. Neither matters much for chapter events,
 * but neither silently lands on the wrong day.
 */
export function zonedToUtc(year, month, day, hour = 0, minute = 0) {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  // The zone's offset a day either side covers both sides of any changeover,
  // so the right answer is one of these two candidates.
  const DAY = 24 * 60 * 60 * 1000;
  const candidates = [...new Set([asIfUtc - offsetAt(asIfUtc - DAY), asIfUtc - offsetAt(asIfUtc + DAY)])];
  const matches = candidates.filter((ts) => {
    const w = wallClock(new Date(ts));
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  });
  // Happens twice (autumn): the first. Never happens (spring): the later
  // reading, i.e. the clock moved forward.
  return new Date(matches.length ? Math.min(...matches) : Math.max(...candidates));
}

/**
 * Parses form text -- "2026-10-15" or "2026-10-15T19:00" -- as chapter time.
 * Returns a Date, or null if the text is not a real date and time.
 */
export function parseLocal(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  // Reject dates that do not exist (Feb 30), which Date.UTC would roll over.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return zonedToUtc(year, month, day, hour, minute);
}

const pad = (n) => String(n).padStart(2, '0');

/** A stored instant as the value a datetime-local input expects. */
export function toLocalInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const w = wallClock(d);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** A stored instant as the value a date input expects. */
export function toLocalDateInput(value) {
  return toLocalInput(value).slice(0, 10);
}

/**
 * An instant `days` calendar days from today, at the given chapter-time
 * hour. Calendar days, not 24-hour steps, so a demo event set for 8 AM is
 * still at 8 AM on the far side of a daylight-saving change.
 */
export function localDaysFromToday(days, hour = 12, minute = 0, now = new Date()) {
  const today = wallClock(now);
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + days));
  return zonedToUtc(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour, minute);
}
