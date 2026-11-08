/**
 * Money is integer cents everywhere inside the domain. Metal mandates pay whole cents only,
 * and Airwallex takes major units, so conversion happens only at those two edges.
 */
export type Cents = number;

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new Error(`cents must be a safe integer, got ${n}`);
  return n;
}

/** "12.34" or 12.34 (major units) → 1234. Rejects sub-cent precision instead of rounding it away. */
export function fromMajor(major: number | string): Cents {
  const s = typeof major === "number" ? major.toFixed(10) : major.trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`not a decimal amount: ${major}`);
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > 2) throw new Error(`sub-cent amount not allowed: ${major}`);
  const value = Number(m[2]) * 100 + Number(frac.padEnd(2, "0"));
  return cents(m[1] ? -value : value);
}

/** 1234 → "12.34" (major units, for Airwallex request bodies). */
export function toMajor(c: Cents): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export const min = (...xs: Cents[]): Cents => Math.min(...xs);
export const max0 = (x: Cents): Cents => Math.max(0, x);
