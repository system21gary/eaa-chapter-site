import config from '../config.js';
import { absoluteUrl } from '../middleware/base-path.js';
import { TZ, toLocalInput, toLocalDateInput } from './localtime.js';
import { whereOf } from './event-format.js';

/**
 * Search and answer-engine helpers: page titles and descriptions that say
 * what and where, and schema.org JSON-LD built from data the site already has.
 *
 * Everything here is public. Nothing about a member goes in beyond what the
 * public page itself shows (a builder's first name), and drafts get no markup.
 */

const site = config.site;
const air = site.airport;

const ORG_ID = () => absoluteUrl('/#organization');

/** The chapter's offset from UTC at that instant, as "-05:00" or "-04:00". */
function offsetAt(date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(part ?? '');
  return m ? `${m[1]}:${m[2] ?? '00'}` : 'Z';
}

/** A stored instant as ISO 8601 in chapter time with its offset, or just the date for all-day events. */
export function localIso(value, { dateOnly = false } = {}) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (dateOnly) return toLocalDateInput(value);
  return `${toLocalInput(value)}:00${offsetAt(d)}`;
}

const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const longDay = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

/** "EAA Chapter Meeting, Thu, Nov 12, 2026": so two meetings never share a title. */
export function eventPageTitle(event) {
  return `${event.title}, ${dateFmt.format(new Date(event.starts_at))}`;
}

/** Trims to a search-snippet length on a word boundary. */
export function clip(text, max = 158) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/[\s,.;:–—-]+\S*$/, '')}…`;
}

/**
 * What a search result or an answer engine should say about an event: the
 * when and where people actually search for, plus the event's own summary
 * when it adds something. A long summary is kept whole (clipped); a short
 * one gets the date and place after it if they fit.
 */
export function eventDescription(event) {
  const summary = String(event.summary ?? '').trim().replace(/[.\s]+$/, '');
  const start = new Date(event.starts_at);
  const when = event.all_day ? longDay.format(start) : `${longDay.format(start)} at ${timeFmt.format(start)}`;
  const where = whereOf(event) || `${air.name} (${air.ident}), ${air.city}, ${air.state}`;
  const cost = event.cost ? ` ${/^free$/i.test(event.cost.trim()) ? 'Free.' : `Cost: ${event.cost.trim()}.`}` : '';
  const status = event.status === 'cancelled' ? 'Cancelled: ' : '';
  const facts = `${when}, ${where}.`;
  const saysSomething = summary && summary.toLowerCase() !== String(event.title).toLowerCase();
  if (saysSomething) {
    const withFacts = `${status}${summary}. ${facts}${cost}`;
    if (withFacts.length <= 158) return withFacts;
    // The short form: "Thu, Nov 12, 2026, 7:00 PM at South Albany Airport (4B0)."
    const shortWhen = event.all_day ? dateFmt.format(start) : `${dateFmt.format(start)}, ${timeFmt.format(start)}`;
    const brief = `${status}${summary}. ${shortWhen} at ${event.location_name || `${air.name} (${air.ident})`}.`;
    if (brief.length <= 158) return brief;
    if (summary.length >= 60) return clip(`${status}${summary}.`);
  }
  return clip(`${status}${saysSomething ? `${summary}. ` : ''}${event.title} on ${facts}${cost}`);
}

/* ------------------------------------------------------------ JSON-LD */

function airportPlace() {
  return {
    '@type': 'Airport',
    name: `${air.name} (${air.ident})`,
    identifier: air.ident,
    address: postal({ address: air.street, city: air.city, state: air.state, zip: air.zip }),
    geo: { '@type': 'GeoCoordinates', latitude: air.latitude, longitude: air.longitude },
  };
}

function postal({ address, city, state, zip }) {
  const out = { '@type': 'PostalAddress', addressCountry: 'US' };
  if (address) out.streetAddress = address;
  if (city) out.addressLocality = city;
  if (state) out.addressRegion = state;
  if (zip) out.postalCode = zip;
  return out;
}

/** The chapter itself. On the home and About pages; everything else refers to it by @id. */
export function organizationLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'NGO',
    '@id': ORG_ID(),
    name: site.name,
    alternateName: [`EAA ${site.chapterNumber}`, `Experimental Aircraft Association Chapter ${site.chapterNumber}`],
    url: absoluteUrl('/'),
    logo: absoluteUrl('/assets/img/eaa-chapter-logo.png'),
    image: absoluteUrl('/assets/img/pancake-breakfast-2026.webp'),
    description: `The Experimental Aircraft Association chapter at ${air.name} (${air.ident}) in ${air.city}, New York: aircraft builders, restorers, pilots and aviation enthusiasts. Fly-in breakfasts, Young Eagles flights for kids aged 8–17, and monthly meetings.`,
    nonprofitStatus: 'Nonprofit501c3',
    address: postal({ address: air.street, city: air.city, state: air.state, zip: air.zip }),
    location: airportPlace(),
    areaServed: 'Capital Region, New York',
    parentOrganization: { '@type': 'Organization', name: 'Experimental Aircraft Association', url: 'https://www.eaa.org' },
    sameAs: [`https://chapters.eaa.org/eaa${site.chapterNumber}`],
    contactPoint: { '@type': 'ContactPoint', contactType: 'general enquiries', url: absoluteUrl('/contact') },
  };
}

export function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': absoluteUrl('/#website'),
    name: site.name,
    url: absoluteUrl('/'),
    publisher: { '@id': ORG_ID() },
    inLanguage: 'en-US',
  };
}

/** Home › section › page. `trail` is [[name, path], …]; the last item is the current page. */
export function breadcrumbLd(trail) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: absoluteUrl(path) })),
  };
}

/** A price from free text: "Free" -> 0, "$10" or "10 dollars" -> 10, anything else -> null. */
function priceOf(cost) {
  const s = String(cost ?? '').trim();
  if (!s) return null;
  if (/^free\b/i.test(s)) return 0;
  const m = /\$?\s*(\d+(?:\.\d{1,2})?)/.exec(s);
  return m ? Number(m[1]) : null;
}

/** schema.org Event, for Google's event listings and for answer engines. Null for drafts. */
export function eventLd(event, { photos = [] } = {}) {
  if (event.status === 'draft') return null;
  const url = absoluteUrl(`/events/${event.slug}`);
  const allDay = Boolean(event.all_day);
  const place = event.address || event.city || event.location_name
    ? {
        '@type': 'Place',
        name: event.location_name || `${air.name} (${air.ident})`,
        address: postal(event),
        ...(event.latitude != null && event.longitude != null
          ? { geo: { '@type': 'GeoCoordinates', latitude: event.latitude, longitude: event.longitude } }
          : {}),
      }
    : airportPlace();
  const images = [event.poster_path, ...photos.map((p) => p.full_path)].filter(Boolean).slice(0, 4).map((p) => absoluteUrl(`/media/${p}`));
  const out = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    '@id': `${url}#event`,
    name: event.title,
    description: eventDescription(event),
    url,
    startDate: localIso(event.starts_at, { dateOnly: allDay }),
    eventStatus: event.status === 'cancelled' ? 'https://schema.org/EventCancelled' : 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: place,
    organizer: { '@type': 'Organization', '@id': ORG_ID(), name: site.name, url: absoluteUrl('/') },
  };
  if (event.ends_at) out.endDate = localIso(event.ends_at, { dateOnly: allDay });
  if (images.length) out.image = images;
  const price = priceOf(event.cost);
  if (price === 0) out.isAccessibleForFree = true;
  if (price != null) {
    out.offers = {
      '@type': 'Offer',
      price: price.toFixed(2),
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      url,
    };
  }
  return out;
}

/**
 * A member's build log as an Article. The author is named the way the public
 * page names them: first name only.
 */
export function buildLd(build, { updates = [] } = {}) {
  const url = absoluteUrl(`/builds/${build.slug}`);
  const published = updates.filter((u) => u.status !== 'draft');
  const latest = published.map((u) => u.posted_at).filter(Boolean).sort().at(-1);
  const modified = [build.updated_at, latest].filter(Boolean).sort().at(-1);
  const out = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${url}#article`,
    headline: clip(build.title, 110),
    description: clip(build.summary || `${build.aircraft_type} project by a member of ${site.name}.`),
    url,
    mainEntityOfPage: url,
    datePublished: localIso(build.created_at),
    dateModified: localIso(modified),
    author: { '@type': 'Person', name: build.owner_first || 'A chapter member', memberOf: { '@id': ORG_ID() } },
    publisher: { '@type': 'Organization', '@id': ORG_ID(), name: site.name, logo: { '@type': 'ImageObject', url: absoluteUrl('/assets/img/eaa-chapter-logo.png') } },
    about: { '@type': 'Thing', name: build.aircraft_type },
    inLanguage: 'en-US',
  };
  if (build.cover_path) out.image = absoluteUrl(`/media/${build.cover_path}`);
  return out;
}
