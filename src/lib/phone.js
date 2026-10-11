/**
 * US-style phone formatting: (518) 396-6775.
 *
 * Only plain 10-digit numbers (or 11 with a leading 1) are touched. Anything
 * with a "+" or a different length is returned as typed, so international
 * numbers and extensions are never mangled.
 */
export function formatPhone(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.startsWith('+')) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10 || /[^\d\s().-]/.test(raw)) return raw;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
