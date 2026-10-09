import sharp from 'sharp';

/**
 * Generated placeholder imagery for the demo dataset.
 *
 * Rendering SVG locally beats shipping stock photos: no licensing, no network
 * at seed time, and every image is deterministic from its seed string so a
 * re-seed produces the same-looking site. These are obviously illustrations,
 * which is the point -- nobody will mistake them for real photos of somebody's
 * actual aeroplane.
 */

const PALETTES = [
  { sky: ['#8ecae6', '#219ebc'], ground: '#8ab17d', accent: '#f2a541', body: '#f4f1de' },
  { sky: ['#ffd9a0', '#f4a261'], ground: '#7a9e7e', accent: '#e76f51', body: '#264653' },
  { sky: ['#bde0fe', '#4895ef'], ground: '#94a187', accent: '#ffd166', body: '#e63946' },
  { sky: ['#cdb4db', '#7b6cd9'], ground: '#6d9773', accent: '#ffc857', body: '#f7f7ff' },
  { sky: ['#a8dadc', '#457b9d'], ground: '#a3b18a', accent: '#f4a261', body: '#1d3557' },
];

/** Deterministic 32-bit hash so the same seed always picks the same palette. */
function hash(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function rng(seed) {
  let state = hash(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state % 10000) / 10000;
  };
}

/** A hangar/field scene with an aeroplane silhouette. */
export function sceneSvg(seed, { width = 1200, height = 800 } = {}) {
  const p = PALETTES[hash(seed) % PALETTES.length];
  const r = rng(seed);
  const horizon = height * (0.62 + r() * 0.08);
  const planeX = width * (0.25 + r() * 0.4);
  const planeY = height * (0.22 + r() * 0.2);
  const scale = 0.8 + r() * 0.5;
  const sunX = width * (0.1 + r() * 0.8);

  const clouds = Array.from({ length: 3 }, (_, i) => {
    const cx = width * (0.1 + r() * 0.8);
    const cy = height * (0.08 + r() * 0.3);
    const cr = 26 + r() * 40;
    return `<g opacity="0.75" transform="translate(${cx.toFixed(0)} ${cy.toFixed(0)})">
      <ellipse cx="0" cy="0" rx="${(cr * 1.6).toFixed(0)}" ry="${cr.toFixed(0)}" fill="#ffffff"/>
      <ellipse cx="${(-cr).toFixed(0)}" cy="${(cr * 0.3).toFixed(0)}" rx="${cr.toFixed(0)}" ry="${(cr * 0.7).toFixed(0)}" fill="#ffffff"/>
      <ellipse cx="${cr.toFixed(0)}" cy="${(cr * 0.25).toFixed(0)}" rx="${(cr * 1.1).toFixed(0)}" ry="${(cr * 0.75).toFixed(0)}" fill="#ffffff"/>
    </g>`;
  }).join('');

  const hills = Array.from({ length: 3 }, (_, i) => {
    const hx = width * (r() * 1.1 - 0.05);
    const hr = width * (0.18 + r() * 0.18);
    return `<ellipse cx="${hx.toFixed(0)}" cy="${horizon.toFixed(0)}" rx="${hr.toFixed(0)}" ry="${(hr * 0.42).toFixed(0)}" fill="${p.ground}" opacity="${(0.45 + i * 0.2).toFixed(2)}"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.sky[0]}"/>
      <stop offset="100%" stop-color="${p.sky[1]}"/>
    </linearGradient>
    <linearGradient id="field" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${p.ground}"/>
      <stop offset="100%" stop-color="#5d7c52"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="${sunX.toFixed(0)}" cy="${(height * 0.16).toFixed(0)}" r="${(height * 0.09).toFixed(0)}" fill="${p.accent}" opacity="0.85"/>
  ${clouds}
  ${hills}
  <rect y="${horizon.toFixed(0)}" width="${width}" height="${(height - horizon).toFixed(0)}" fill="url(#field)"/>
  <rect y="${(horizon + (height - horizon) * 0.45).toFixed(0)}" width="${width}" height="${((height - horizon) * 0.16).toFixed(0)}" fill="#d9cbb0" opacity="0.75"/>

  <g transform="translate(${planeX.toFixed(0)} ${planeY.toFixed(0)}) scale(${scale.toFixed(2)})">
    <ellipse cx="0" cy="0" rx="120" ry="20" fill="${p.body}"/>
    <path d="M-40 -6 L60 -6 L96 6 L-40 6 Z" fill="${p.body}"/>
    <rect x="-110" y="-46" width="150" height="12" rx="6" fill="${p.accent}"/>
    <rect x="-80" y="30" width="120" height="10" rx="5" fill="${p.accent}"/>
    <path d="M-120 -4 L-150 -44 L-134 -44 L-108 -6 Z" fill="${p.body}"/>
    <circle cx="52" cy="-14" r="16" fill="#2b3a4a" opacity="0.75"/>
    <rect x="112" y="-42" width="7" height="84" rx="3" fill="#2b3a4a" opacity="0.55"/>
    <circle cx="-46" cy="30" r="12" fill="#2b3a4a"/>
    <circle cx="26" cy="30" r="12" fill="#2b3a4a"/>
  </g>
</svg>`;
}

/** A workbench/tool still-life, for Tool Locker listings. */
export function toolSvg(seed, { width = 1000, height = 750 } = {}) {
  const p = PALETTES[hash(seed) % PALETTES.length];
  const r = rng(seed);
  const bench = height * 0.68;

  const items = Array.from({ length: 4 }, (_, i) => {
    const x = width * (0.12 + i * 0.22 + r() * 0.03);
    const h = height * (0.12 + r() * 0.2);
    const w = width * (0.05 + r() * 0.07);
    const fill = i % 2 ? p.accent : p.body;
    return `<g transform="translate(${x.toFixed(0)} ${(bench - h).toFixed(0)})">
      <rect width="${w.toFixed(0)}" height="${h.toFixed(0)}" rx="${(w * 0.25).toFixed(0)}" fill="${fill}"/>
      <rect y="${(h * 0.55).toFixed(0)}" width="${w.toFixed(0)}" height="${(h * 0.12).toFixed(0)}" fill="#2b3a4a" opacity="0.35"/>
      <circle cx="${(w / 2).toFixed(0)}" cy="${(h * 0.2).toFixed(0)}" r="${(w * 0.18).toFixed(0)}" fill="#2b3a4a" opacity="0.45"/>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e8e2d6"/>
      <stop offset="100%" stop-color="#cfc6b5"/>
    </linearGradient>
    <linearGradient id="wood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#a9754d"/>
      <stop offset="100%" stop-color="#7d5233"/>
    </linearGradient>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#wall)"/>
  ${Array.from({ length: 6 }, (_, i) =>
    `<rect x="0" y="${((height / 7) * (i + 1)).toFixed(0)}" width="${width}" height="2" fill="#000" opacity="0.04"/>`
  ).join('')}
  <rect x="${(width * 0.06).toFixed(0)}" y="${(height * 0.1).toFixed(0)}" width="${(width * 0.88).toFixed(0)}" height="${(height * 0.42).toFixed(0)}" rx="10" fill="#000" opacity="0.05"/>
  ${items}
  <rect y="${bench.toFixed(0)}" width="${width}" height="${(height - bench).toFixed(0)}" fill="url(#wood)"/>
  <rect y="${bench.toFixed(0)}" width="${width}" height="8" fill="#000" opacity="0.15"/>
</svg>`;
}

/** Renders one of the generators to a PNG buffer the image pipeline accepts. */
export async function renderPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}
