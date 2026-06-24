// Pure presentation helpers — strings, color, and the table's column widths.
// No signals or BPF, so it's safe to import anywhere; the components reach it
// through the `@/` alias (resolved at bundle time).
import { rgb } from "yeet:tui";

/* Per-method accent colors — all vibrant, no greys. */
export const METHOD_COLORS = {
  GET: rgb(0x50fa7b), POST: rgb(0xf1fa8c), PUT: rgb(0x8be9fd),
  PATCH: rgb(0xbd93f9), DELETE: rgb(0xff5555), HEAD: rgb(0xff79c6),
  OPTIONS: rgb(0xffb86c), CONNECT: rgb(0x80ffea), TRACE: rgb(0xd6acff),
};
export const METHOD_FALLBACK = rgb(0xbd93f9);
export const methodColor = (m) => METHOD_COLORS[m] || METHOD_FALLBACK;

export const accent = rgb(0x8be9fd); /* cyan: brand, counts, selection */
export const rateOn = rgb(0x50fa7b); /* green: a live (>0) req/s value */
export const muted  = rgb(0x8b9bf5); /* soft indigo: secondary text (replaces dim) */
export const grid   = rgb(0x6d5dfc); /* indigo: table border + dividers */
export const selBg  = rgb(0x3b3168); /* indigo-violet: highlighted/selected row */
export const label  = rgb(0xff79c6); /* pink: field labels / header names */

/* Fixed column widths (cells); PATH takes the remaining 1fr. HOST is flexible:
 * at least 20 cells, ~30% of the row, capped at 64 — so long FQDN:port hosts
 * (e.g. `auth.yeet.plumbing:8081`) show in full on a wide terminal and fall
 * back to ellipsis only when genuinely cramped. */
export const W_RANK = 4, W_METHOD = 8, W_COUNT = 8, W_RATE = 8, W_LAST = 6, W_STATUS = 5, W_LAT = 7;
export const W_HOST = "clamp(20, 30%, 64)";

export const pad = (s, w) => String(s).padStart(w);
export const padEnd = (s, w) => String(s).padEnd(w);

/* 1234 -> "1.2k", 12345 -> "12k", 1_200_000 -> "1.2M" */
export function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(0) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

/* requests/sec to one decimal for readable low rates; k/M for high ones. */
export function fmtRate(n) {
  return n >= 1000 ? fmtCount(n) : n.toFixed(1);
}

export function fmtBytes(n) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + u[i];
}

/* elapsed ms -> "now" / "5s" / "3m" / "2h" */
export function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 1) return "now";
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

/* seconds-of-uptime -> "42s" / "3m12s" */
export function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

/* milliseconds -> "0.42ms" / "7.3ms" / "84ms" / "1.20s" */
export function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(2) + "s";
  if (ms >= 10) return Math.round(ms) + "ms";
  if (ms >= 1) return ms.toFixed(1) + "ms";
  return ms.toFixed(2) + "ms";
}

/* HTTP status code -> color by class (2xx green, 3xx blue, 4xx yellow, 5xx red). */
export function statusColor(code) {
  if (code >= 500) return rgb(0xff5555);
  if (code >= 400) return rgb(0xf1fa8c);
  if (code >= 300) return rgb(0x8be9fd);
  if (code >= 200) return rgb(0x50fa7b);
  return METHOD_FALLBACK;
}

/* Sum a row's { code: count } status map into { 2,3,4,5 } class buckets
 * (1xx and unparsed 0 are dropped). */
export function statusClasses(status) {
  const b = { 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const code in status) {
    const c = Math.floor(Number(code) / 100);
    if (b[c] !== undefined) b[c] += status[code];
  }
  return b;
}

/* Latency heat: white (fast) → red (slow), saturating at ~500ms. */
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
export function latColor(ms) {
  const t = Math.max(0, Math.min(1, ms / 500));
  const white = [0xff, 0xff, 0xff], red = [0xff, 0x55, 0x55];
  return rgb(lerp(white[0], red[0], t), lerp(white[1], red[1], t), lerp(white[2], red[2], t));
}

/* p-th percentile (0..100) of an unsorted numeric array; 0 if empty. */
export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/* A unicode block sparkline of the last `width` samples, scaled to `max`
 * (or the series max). Empty samples render as spaces. */
const SPARK = " ▁▂▃▄▅▆▇█";
export function sparkline(values, width, max = 0) {
  const v = values.slice(-width);
  const hi = Math.max(max, 1, ...v);
  const body = v.map((x) => SPARK[Math.max(0, Math.min(8, Math.round((x / hi) * 8)))]).join("");
  return " ".repeat(Math.max(0, width - v.length)) + body;
}
