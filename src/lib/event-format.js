import config from '../config.js';
import { TZ, toLocalDateInput, zonedToUtc } from './localtime.js';

/** How an event's date, time and place read in email and on the notice pages. Always chapter time. */

const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });

export function whenOf(event) {
  const start = new Date(event.starts_at);
  const day = fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const shortDay = fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(start);
  const time = event.all_day ? null : fmt({ hour: 'numeric', minute: '2-digit' }).format(start);
  return {
    day,
    time,
    long: time ? `${day} at ${time}` : day,
    short: time ? `${shortDay}, ${time}` : shortDay,
  };
}

export function whereOf(event) {
  return [event.location_name, [event.address, event.city, event.state].filter(Boolean).join(', ')]
    .filter(Boolean)
    .join(', ');
}

/** 9:00 (or `hour`) chapter time, `daysBefore` calendar days before the event's date. */
export function localDayAt(event, daysBefore, hour = config.scheduler.reminderHour) {
  const [y, m, d] = toLocalDateInput(event.starts_at).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d - daysBefore));
  return zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, 0);
}

/** "2026-10-19" for an instant, in chapter time. */
export const localDate = (instant) => toLocalDateInput(instant);

export const KIND_LABELS = {
  meeting: 'Meeting',
  'fly-in': 'Fly-in',
  'young-eagles': 'Young Eagles',
  workshop: 'Workshop',
  social: 'Social',
  chapter: 'Chapter event',
};

/** What each type of event sends unless an editor says otherwise. */
export const REMINDER_DEFAULTS = {
  meeting: 'day',
  workshop: 'day',
  'fly-in': 'week_and_day',
  'young-eagles': 'week_and_day',
  social: 'off',
  chapter: 'off',
};

export const REMINDER_LABELS = {
  off: 'No reminder',
  day: 'The day before',
  week_and_day: 'A week before and the day before',
};

export const effectiveReminders = (event) => event.reminders || REMINDER_DEFAULTS[event.kind] || 'off';

/** The rain date as a date ("Tuesday, October 27"). It is stored as the start of that day, chapter time. */
export function rainDateText(event) {
  if (!event?.rain_date) return null;
  return fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(event.rain_date));
}
