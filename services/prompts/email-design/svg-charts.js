'use strict';

/**
 * services/prompts/email-design/svg-charts.js
 * ----------------------------------------------------------------------------
 * Inline SVG chart generators. All functions return self-contained SVG strings
 * that work in every email client (Gmail, Outlook, Apple Mail).
 *
 * No external dependencies, no JS, no fonts loaded externally — just plain SVG.
 * ----------------------------------------------------------------------------
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─── Sparkline (trend over time) ───────────────────────────────────────────

/**
 * Tiny single-line trend chart. Used for ROAS / spend / engagement trends.
 *
 * @param {{ values: number[], color?: string, width?: number, height?: number, fillUnder?: boolean }} opts
 * @returns {string} SVG markup
 */
function sparkline({ values, color = '#3B82F6', width = 160, height = 40, fillUnder = true }) {
  if (!Array.isArray(values) || values.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const range = max - min || 1;
  const padX = 4;
  const padY = 4;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;
  const points = valid.map((v, i) => {
    const x = padX + (i / (valid.length - 1)) * innerW;
    const y = padY + innerH - ((v - min) / range) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const last = valid[valid.length - 1];
  const lastX = padX + innerW;
  const lastY = padY + innerH - ((last - min) / range) * innerH;

  const fill = fillUnder
    ? `<polygon points="${padX},${height - padY} ${points} ${lastX},${height - padY}" fill="${color}" fill-opacity="0.10"/>`
    : '';

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Trend chart">
${fill}
<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${color}"/>
</svg>`;
}

// ─── Bar chart (categorical comparison) ─────────────────────────────────────

/**
 * Horizontal-bar comparison chart. Used for spend by campaign, ROAS by channel.
 *
 * @param {{ items: Array<{label: string, value: number}>, color?: string, valueFormatter?: function, width?: number }} opts
 */
function bar({ items, color = '#3B82F6', valueFormatter, width = 320 }) {
  if (!Array.isArray(items) || !items.length) {
    return `<svg width="${width}" height="40" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const max = Math.max(...items.map(i => Math.max(0, Number(i.value) || 0)), 0.01);
  const rowH = 22;
  const rowGap = 4;
  const labelW = 90;
  const valueW = 60;
  const barW = width - labelW - valueW - 8;
  const height = items.length * (rowH + rowGap) + 8;

  const fmt = typeof valueFormatter === 'function'
    ? valueFormatter
    : (v) => Number.isFinite(Number(v)) ? Number(v).toFixed(2) : String(v);

  const rows = items.map((it, i) => {
    const v = Math.max(0, Number(it.value) || 0);
    const w = (v / max) * barW;
    const y = 4 + i * (rowH + rowGap);
    return `<text x="0" y="${y + rowH / 2 + 4}" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#374151">${escapeXml(it.label).slice(0, 14)}</text>
<rect x="${labelW}" y="${y}" width="${barW.toFixed(1)}" height="${rowH}" rx="3" fill="#F3F4F6"/>
<rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${rowH}" rx="3" fill="${color}"/>
<text x="${labelW + barW + 4}" y="${y + rowH / 2 + 4}" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#374151">${escapeXml(fmt(it.value))}</text>`;
  }).join('\n');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Bar chart">
${rows}
</svg>`;
}

// ─── Gauge (0-100 score) ────────────────────────────────────────────────────

/**
 * Half-circle gauge for displaying a 0-100 score.
 *
 * @param {{ value: number, label?: string, width?: number, color?: string }} opts
 */
function gauge({ value, label = '', width = 140, color }) {
  const v = clamp(Number(value) || 0, 0, 100);
  const h = Math.round(width * 0.6);
  const cx = width / 2;
  const cy = h - 8;
  const r = (width / 2) - 12;
  const angleStart = Math.PI;
  const angleEnd = 0;
  const angleValue = angleStart - (v / 100) * Math.PI;

  const arcColor = color || (v >= 70 ? '#10B981' : v >= 40 ? '#F59E0B' : '#EF4444');

  function arcPath(a0, a1, sweep = 0) {
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  return `<svg width="${width}" height="${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Score gauge">
<path d="${arcPath(angleStart, angleEnd, 0)}" fill="none" stroke="#E5E7EB" stroke-width="8" stroke-linecap="round"/>
<path d="${arcPath(angleStart, angleValue, 0)}" fill="none" stroke="${arcColor}" stroke-width="8" stroke-linecap="round"/>
<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="20" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#111827">${Math.round(v)}</text>
${label ? `<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#6B7280">${escapeXml(label)}</text>` : ''}
</svg>`;
}

// ─── Donut (proportion breakdown) ───────────────────────────────────────────

/**
 * Donut chart for sentiment / category breakdowns.
 *
 * @param {{ slices: Array<{label, value, color}>, width?: number, centerLabel?: string }} opts
 */
function donut({ slices, width = 140, centerLabel }) {
  if (!Array.isArray(slices) || !slices.length) {
    return `<svg width="${width}" height="${width}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const total = slices.reduce((a, s) => a + Math.max(0, Number(s.value) || 0), 0);
  if (total === 0) {
    return `<svg width="${width}" height="${width}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const cx = width / 2;
  const cy = width / 2;
  const rOuter = (width / 2) - 8;
  const rInner = rOuter * 0.55;

  const defaultColors = ['#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#8B5CF6'];
  let cumAngle = -Math.PI / 2;

  const paths = slices.map((s, i) => {
    const v = Math.max(0, Number(s.value) || 0);
    if (v === 0) return '';
    const angleSweep = (v / total) * 2 * Math.PI;
    const a0 = cumAngle;
    const a1 = cumAngle + angleSweep;
    cumAngle = a1;
    const largeArc = angleSweep > Math.PI ? 1 : 0;
    const x0o = cx + rOuter * Math.cos(a0);
    const y0o = cy + rOuter * Math.sin(a0);
    const x1o = cx + rOuter * Math.cos(a1);
    const y1o = cy + rOuter * Math.sin(a1);
    const x0i = cx + rInner * Math.cos(a1);
    const y0i = cy + rInner * Math.sin(a1);
    const x1i = cx + rInner * Math.cos(a0);
    const y1i = cy + rInner * Math.sin(a0);
    const fill = s.color || defaultColors[i % defaultColors.length];
    return `<path d="M ${x0o.toFixed(2)} ${y0o.toFixed(2)} A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)} L ${x0i.toFixed(2)} ${y0i.toFixed(2)} A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i.toFixed(2)} ${y1i.toFixed(2)} Z" fill="${fill}"/>`;
  }).join('\n');

  const center = centerLabel ? `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="14" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#111827">${escapeXml(centerLabel)}</text>` : '';

  return `<svg width="${width}" height="${width}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Donut chart">
${paths}
${center}
</svg>`;
}

module.exports = {
  escapeXml,
  sparkline,
  bar,
  gauge,
  donut,
};
