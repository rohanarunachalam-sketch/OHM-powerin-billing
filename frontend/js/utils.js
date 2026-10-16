// Shared helpers: escaping, formatting and decimal-safe money arithmetic.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape any value for safe interpolation into HTML. */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

// ---------------------------------------------------------------------------
// Decimal arithmetic with BigInt (mirrors backend/services/calculations.py)
// ---------------------------------------------------------------------------

/** Parse a decimal string into a scaled BigInt, e.g. ("12.5", 2) -> 1250n. Returns null if invalid. */
export function toScaled(value, places) {
  const text = String(value ?? "").trim();
  if (text === "") return 0n;
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) return null;
  const [, sign, whole, frac = ""] = match;
  if (frac.length > places) return null;
  const scaled = BigInt((whole || "0") + frac.padEnd(places, "0"));
  return sign ? -scaled : scaled;
}

/** Round-half-up integer division for non-negative numerators. */
export function divRound(numerator, denominator) {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}

/** Format a scaled BigInt as a plain decimal string. */
export function scaledToString(value, places) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places);
  return `${negative ? "-" : ""}${whole}${places ? "." + frac : ""}`;
}

export const paise = (value) => toScaled(value, 2);
export const paiseToString = (value) => scaledToString(value, 2);

/**
 * Live calculation of one line. qty has 3 places, money and percentages 2 places.
 * Returns null when inputs are incomplete/invalid.
 */
export function calcLine({ quantity, rate, discountType, discountValue, gstRate }, interstate) {
  const qty = toScaled(quantity, 3);
  const r = toScaled(rate, 2);
  const dv = toScaled(discountValue || "0", 2);
  const g = toScaled(gstRate, 2);
  if (qty === null || r === null || dv === null || g === null || qty <= 0n || r < 0n || dv < 0n) return null;

  const gross = divRound(qty * r, 1000n);
  const discount = discountType === "amount" ? dv : divRound(gross * dv, 10000n);
  if (discount > gross) return null;
  const taxable = gross - discount;
  let cgst = 0n, sgst = 0n, igst = 0n;
  if (interstate) igst = divRound(taxable * g, 10000n);
  else { cgst = divRound(taxable * g, 20000n); sgst = cgst; }
  return { gross, discount, taxable, cgst, sgst, igst, tax: cgst + sgst + igst };
}

export function calcTotals(lines, interstate) {
  const totals = { subtotal: 0n, discount: 0n, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, valid: true };
  for (const line of lines) {
    const result = calcLine(line, interstate);
    if (!result) { totals.valid = false; continue; }
    totals.subtotal += result.gross;
    totals.discount += result.discount;
    totals.taxable += result.taxable;
    totals.cgst += result.cgst;
    totals.sgst += result.sgst;
    totals.igst += result.igst;
  }
  const exact = totals.taxable + totals.cgst + totals.sgst + totals.igst;
  totals.grand = divRound(exact, 100n) * 100n;
  totals.roundOff = totals.grand - exact;
  return totals;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function groupIndian(whole) {
  if (whole.length <= 3) return whole;
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${head},${tail}`;
}

/** Format a decimal string/number as Indian currency, e.g. "245000" -> "₹2,45,000.00". */
export function money(value, { symbol = true, decimals = 2 } = {}) {
  let scaled = toScaled(typeof value === "bigint" ? paiseToString(value) : String(value ?? "0"), 2);
  if (scaled === null) scaled = 0n;
  if (decimals === 0) scaled = divRound(scaled, 100n) * 100n;
  const text = scaledToString(scaled, 2);
  const negative = text.startsWith("-");
  const [whole, frac] = text.replace("-", "").split(".");
  const body = groupIndian(whole) + (decimals ? "." + frac : "");
  return `${negative ? "-" : ""}${symbol ? "₹" : ""}${body}`;
}

export const moneyFromPaise = (p, opts) => money(paiseToString(p), opts);

/** Trim trailing zeros from a decimal string: "10.000" -> "10", "7.50" -> "7.5". */
export function trimNumber(value) {
  const text = String(value ?? "");
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-12" -> "12 Oct 2026" */
export function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "2026-10-12" -> "12-10-2026" (matches the PDF) */
export function fmtDateNumeric(iso) {
  if (!iso) return "-";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}

export function todayISO() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

export function statusPill(status) {
  const cls = "pill-" + String(status).toLowerCase().replace(/\s+/g, "-");
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Small inline icon set
export const icons = {
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v14h-2zM5 11h14v2H5z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.3V21h3.8l11-11.1-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2zm0-8h-2V7h2z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9zM8 13h8v2H8zm0 4h5v2H8z"/></svg>',
  users: '<svg viewBox="0 0 24 24"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M21 16.5V7.5L12 2 3 7.5v9l9 5.5zM12 4.3l6.4 3.9L12 12 5.6 8.2zM5 9.9l6 3.6v6.9l-6-3.6zm8 10.5v-6.9l6-3.6v6.9z"/></svg>',
  rupee: '<svg viewBox="0 0 24 24"><path d="M6 3h12v2h-3.2c.5.6.9 1.3 1.1 2H18v2h-2.1c-.4 2.7-2.6 4.8-5.4 5h-.6l6.3 7h-2.7l-6.3-7v-2h3c1.8 0 3.2-1.3 3.4-3H6V7h7.4c-.6-1.2-1.8-2-3.4-2H6z"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M19 8H5a3 3 0 0 0-3 3v6h4v4h12v-4h4v-6a3 3 0 0 0-3-3zm-3 11H8v-5h8zm3-7a1 1 0 1 1 0-2 1 1 0 0 1 0 2zM18 3H6v4h12z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  ban: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A8 8 0 0 1 4 12zm8 8a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>',
};
