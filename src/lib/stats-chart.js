/**
 * A single-series column chart as inline SVG, built on the server.
 *
 * One series, so no legend: the card's title says what it is. Thin columns
 * (never wider than 24px) with a 4px rounded top and a square base, a 2px gap
 * between neighbours, one recessive hairline grid, text in ink (never in the
 * data colour), and only the highest column labelled. Every column carries a
 * data-tip for the hover tooltip; the same numbers are in the table view.
 */
const W = 720;
const H = 200;
const M = { left: 38, right: 8, top: 18, bottom: 26 };

const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Smallest "round" number at or above max whose half is also whole, so the gridlines read cleanly. */
export function niceTop(max) {
  const steps = [4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100];
  for (let mag = 1; ; mag *= 10) {
    for (const step of steps) {
      if (step * mag >= max && step * mag >= 4) return step * mag;
    }
    if (mag > 1e9) return Math.ceil(max / 2) * 2;
  }
}

function dayLabel(day, long = false) {
  // `day` is YYYY-MM-DD in chapter time; format it as that calendar date.
  const d = new Date(`${day}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    ...(long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' }),
  }).format(d);
}

export function columnChart(rows, field, { noun = 'views' } = {}) {
  const n = rows.length;
  const values = rows.map((r) => r[field] ?? 0);
  const max = Math.max(0, ...values);
  const top = niceTop(max);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const base = M.top + plotH;
  const slot = plotW / n;
  const barW = Math.min(24, Math.max(2, slot - 2));
  const r = Math.min(4, barW / 2);
  const total = values.reduce((a, b) => a + b, 0);

  const parts = [];
  parts.push(
    `<svg class="stat-chart" viewBox="0 0 ${W} ${H}" role="img" ` +
      `aria-label="${esc(`${total} ${noun} over the last ${n} days. A table of the numbers follows.`)}">`
  );

  // Gridlines and y-axis labels: 0, half, top.
  for (const t of [0, top / 2, top]) {
    const y = base - (t / top) * plotH;
    parts.push(`<line class="stat-grid" x1="${M.left}" x2="${W - M.right}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="stat-axis" x="${M.left - 6}" y="${y + 4}" text-anchor="end">${t.toLocaleString('en-US')}</text>`);
  }

  // x-axis: first, middle and last day only.
  const ticks = [[0, 'start'], [Math.floor((n - 1) / 2), 'middle'], [n - 1, 'end']];
  for (const [i, anchor] of ticks) {
    const x = anchor === 'start' ? M.left : anchor === 'end' ? W - M.right : M.left + i * slot + slot / 2;
    parts.push(`<text class="stat-axis" x="${x}" y="${H - 6}" text-anchor="${anchor}">${esc(dayLabel(rows[i].day))}</text>`);
  }

  // Columns. The hit area is the whole slot, so thin columns are easy to hover.
  const maxIndex = values.indexOf(max);
  rows.forEach((row, i) => {
    const v = values[i];
    const x = M.left + i * slot + (slot - barW) / 2;
    const tip = `${dayLabel(row.day, true)}: ${v.toLocaleString('en-US')} ${v === 1 ? noun.replace(/s$/, '') : noun}`;
    parts.push(`<g data-tip="${esc(tip)}">`);
    parts.push(`<rect class="stat-hit" x="${M.left + i * slot}" y="${M.top}" width="${slot}" height="${plotH}"/>`);
    if (v > 0) {
      const h = Math.max((v / top) * plotH, r + 1);
      const y = base - h;
      parts.push(
        `<path class="stat-bar" d="M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + barW - r}` +
          `Q${x + barW} ${y} ${x + barW} ${y + r}V${base}Z"/>`
      );
    }
    parts.push('</g>');
  });

  // Label only the tallest column.
  if (max > 0) {
    const x = M.left + maxIndex * slot + slot / 2;
    const y = base - (max / top) * plotH - 5;
    parts.push(`<text class="stat-value" x="${x}" y="${y}" text-anchor="middle">${max.toLocaleString('en-US')}</text>`);
  }

  parts.push('</svg>');
  return parts.join('');
}
