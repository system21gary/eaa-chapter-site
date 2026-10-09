import { parseLocal } from './localtime.js';

/**
 * Small allow-list validator.
 *
 * Every route runs untrusted input through a schema before it reaches the
 * database. Fields not named in the schema are dropped, so an attacker cannot
 * smuggle extra columns (`role`, `status`, `owner_id`) into an update by
 * adding form fields -- mass assignment is impossible by construction.
 */

export class ValidationError extends Error {
  constructor(errors) {
    super('Please correct the highlighted fields.');
    this.status = 400;
    this.code = 'EVALIDATION';
    this.errors = errors;
  }
}

const EMAIL_RE = /^[^\s@<>"'`;]+@[^\s@<>"'`;]+\.[a-z]{2,}$/i;
// Deliberately narrow: only absolute http(s) links, never javascript: or data:.
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const f = {
  string({ min = 0, max = 500, trim = true, label } = {}) {
    return (value, name) => {
      let v = value == null ? '' : String(value);
      if (trim) v = v.trim();
      // Strip control characters and zero-width joiners used to smuggle
      // lookalike content past moderation.
      v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/gu, '');
      if (v.length < min) throw `${label || name} must be at least ${min} characters.`;
      if (v.length > max) throw `${label || name} must be ${max} characters or fewer.`;
      return v;
    };
  },

  optionalString(opts = {}) {
    const inner = f.string({ ...opts, min: 0 });
    return (value, name) => {
      const v = inner(value, name);
      return v === '' ? null : v;
    };
  },

  email({ label = 'Email' } = {}) {
    return (value, name) => {
      const v = String(value ?? '').trim().toLowerCase();
      if (v.length > 254 || !EMAIL_RE.test(v)) throw `${label} does not look like a valid address.`;
      return v;
    };
  },

  url({ label = 'Link', optional = true } = {}) {
    return (value, name) => {
      const v = String(value ?? '').trim();
      if (!v) {
        if (optional) return null;
        throw `${label} is required.`;
      }
      if (v.length > 500 || !URL_RE.test(v)) throw `${label} must be a full http:// or https:// address.`;
      return v;
    };
  },

  slug({ label = 'Slug' } = {}) {
    return (value, name) => {
      const v = String(value ?? '').trim().toLowerCase();
      if (!SLUG_RE.test(v) || v.length > 120) {
        throw `${label} may only contain lowercase letters, numbers and hyphens.`;
      }
      return v;
    };
  },

  enum(values, { label, optional = false, fallback } = {}) {
    return (value, name) => {
      const v = String(value ?? '').trim();
      if (!v && (optional || fallback !== undefined)) return fallback ?? null;
      if (!values.includes(v)) throw `${label || name} is not one of the allowed choices.`;
      return v;
    };
  },

  int({ min = -2147483648, max = 2147483647, optional = false, label } = {}) {
    return (value, name) => {
      const raw = String(value ?? '').trim();
      if (!raw && optional) return null;
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) throw `${label || name} must be a number.`;
      if (n < min || n > max) throw `${label || name} must be between ${min} and ${max}.`;
      return n;
    };
  },

  float({ min = -1e12, max = 1e12, optional = true, label } = {}) {
    return (value, name) => {
      const raw = String(value ?? '').trim();
      if (!raw && optional) return null;
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n)) throw `${label || name} must be a number.`;
      if (n < min || n > max) throw `${label || name} is out of range.`;
      return n;
    };
  },

  bool() {
    return (value) => (['1', 'true', 'on', 'yes'].includes(String(value ?? '').toLowerCase()) ? 1 : 0);
  },

  /** Accepts `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` from native date inputs. */
  datetime({ optional = true, label } = {}) {
    return (value, name) => {
      const raw = String(value ?? '').trim();
      if (!raw && optional) return null;
      // Read as chapter time, not the server's: see lib/localtime.js.
      const d = parseLocal(raw);
      if (!d) throw `${label || name} must be a valid date.`;
      return d.toISOString();
    };
  },

  phone({ optional = true, label = 'Phone' } = {}) {
    return (value, name) => {
      const raw = String(value ?? '').trim();
      if (!raw && optional) return null;
      const digits = raw.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) throw `${label} does not look like a valid number.`;
      return raw.slice(0, 32);
    };
  },

  /** Comma or space separated tags, normalised and de-duplicated. */
  tags({ max = 8 } = {}) {
    return (value) => {
      const list = String(value ?? '')
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-'))
        .filter(Boolean);
      return [...new Set(list)].slice(0, max);
    };
  },
};

export function validate(input, schema) {
  const out = {};
  const errors = {};
  for (const [name, rule] of Object.entries(schema)) {
    try {
      out[name] = rule(input?.[name], name);
    } catch (message) {
      errors[name] = typeof message === 'string' ? message : 'Invalid value.';
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

export function slugify(text, { maxLength = 80 } = {}) {
  const base = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    // Drop apostrophes rather than turning them into separators, so
    // "Marta's RV-7A" becomes "martas-rv-7a" and not "marta-s-rv-7a".
    .replace(/['\u2018\u2019\u02bc]/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return base || 'untitled';
}
