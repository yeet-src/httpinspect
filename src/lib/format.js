// Pure presentation helpers — strings, color, and the table's column widths.
// No signals or BPF, so it's safe to import anywhere; the components reach it
// through the `@/` alias (resolved at bundle time).
import { rgb, idx } from "yeet:tui";

/* Per-method accent colors; unknown methods fall back to plain grey. */
export const METHOD_COLORS = {
  GET: rgb(0x4ec9b0), POST: rgb(0xdcdcaa), PUT: rgb(0x9cdcfe),
  PATCH: rgb(0xc586c0), DELETE: rgb(0xf48771), HEAD: rgb(0x808080),
  OPTIONS: rgb(0x808080), CONNECT: rgb(0x808080), TRACE: rgb(0x808080),
};
export const METHOD_FALLBACK = idx(7);
export const methodColor = (m) => METHOD_COLORS[m] || METHOD_FALLBACK;

export const accent = rgb(0x4fc1ff); /* httptop brand + count column */
export const rateOn = rgb(0x4ec9b0); /* a live (>0) req/s value */
export const grid = idx(8);          /* table border */
export const selBg = idx(236);       /* highlighted row in the list */
export const label = idx(244);       /* detail-screen field labels */

/* Fixed column widths (cells). PATH is capped so the numeric columns land in
 * the same screen position on every row; a trailing 1fr spacer absorbs any
 * leftover width on wide terminals. */
export const W_RANK = 4, W_METHOD = 8, W_COUNT = 8, W_RATE = 8, W_HOST = 22, W_LAST = 6, W_ERR = 7, W_PATH = 50;

export const pad = (s, w) => String(s).padStart(w);
export const padEnd = (s, w) => String(s).padEnd(w);

/* Fit a left-aligned string to exactly `w` columns: elide with `…` past the
 * width, pad out below it. A Text's `width` is only a max — it won't pad short
 * content for us — so a constant-width column has to carry its own padding. */
export const cell = (s, w) => {
  s = String(s);
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s.padEnd(w);
};

/* 1234 -> "1.2k", 12345 -> "12k", 1_200_000 -> "1.2M" */
export function fmtCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(0) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
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

/* error fraction (0..1) -> "·" when none, else "0.4%" / "12%" / "73%". */
export function fmtErrPct(rate) {
  if (rate <= 0) return "·";
  const p = rate * 100;
  if (p >= 10) return Math.round(p) + "%";
  return p.toFixed(1) + "%";
}

/* error fraction (0..1) -> heat color: grey none, yellow some, red bad. */
export function errColor(rate) {
  if (rate <= 0) return label;
  if (rate < 0.15) return rgb(0xdcdcaa); // yellow — baseline noise
  return rgb(0xf48771);                   // red — a real incident
}

/* HTTP status code -> color by class (2xx green, 3xx blue, 4xx yellow, 5xx red). */
export function statusColor(code) {
  if (code >= 500) return rgb(0xf48771);
  if (code >= 400) return rgb(0xdcdcaa);
  if (code >= 300) return rgb(0x9cdcfe);
  if (code >= 200) return rgb(0x4ec9b0);
  return METHOD_FALLBACK;
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
