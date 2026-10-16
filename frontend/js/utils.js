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

// Icon set (Lucide, vendored in icons.js). Keys are the names views already use.
import { icon } from "./icons.js";

export { icon };
export const icons = Object.fromEntries(
  ["search", "plus", "edit", "trash", "eye", "download", "close", "check", "alert", "info", "doc", "users", "box", "rupee",
    "print", "back", "ban", "upload", "more", "wallet", "chart", "dashboard", "settings", "building", "copy", "calendar",
    "filePlus", "checkCircle", "receipt", "trendUp", "clock", "chevronDown", "menu"].map((name) => [name, icon(name)]),
);
