// Money for staff pay: integer minor units (cents, yen, fils) as bigint, never floating point.
//
// Rates and multipliers are decimals with a fixed scale (4 places), held as scaled bigints, so
// "20.375" per hour and "1.5" times are exact. Every amount is rounded once, half away from zero,
// to the currency's own minor unit (USD 2 places, JPY 0, KWD 3).
//
// Imported by the UI through `@app/shared/staff`: relative imports stay extensionless.

/** Decimal places kept for hourly rates. */
export const RATE_SCALE = 4;
/** Decimal places kept for overtime and holiday multipliers. */
export const MULTIPLIER_SCALE = 4;

const DECIMAL_RE = /^(\d{1,15})(?:\.(\d+))?$/;
const exponents = new Map<string, number>();

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Whether `code` is an ISO 4217 currency code this runtime can format. */
export function isCurrencyCode(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** Minor-unit decimal places of a currency: USD 2, JPY 0, KWD 3. */
export function currencyExponent(currency: string): number {
  const cached = exponents.get(currency);
  if (cached !== undefined) return cached;
  let exp = 2;
  try {
    exp = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    exp = 2;
  }
  exponents.set(currency, exp);
  return exp;
}

const pow10 = (n: number) => 10n ** BigInt(n);

/**
 * Parse a non-negative decimal written with a dot ("20", "20.5", "0.375") into a bigint scaled by
 * 10^scale. More decimal places than `scale` is an error rather than a silent rounding: a pay rate
 * of 20.37501 is a typo, not a rate.
 */
export function parseDecimal(input: string, scale: number): bigint {
  const s = input.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new MoneyError(`"${input}" is not a valid amount`);
  const frac = m[2] ?? "";
  if (frac.length > scale) throw new MoneyError(`"${input}" has more than ${scale} decimal places`);
  return BigInt(m[1]!) * pow10(scale) + BigInt(frac.padEnd(scale, "0") || "0");
}

/** Whether `input` parses with `parseDecimal` at `scale`. */
export function isDecimal(input: string, scale: number): boolean {
  try {
    parseDecimal(input, scale);
    return true;
  } catch {
    return false;
  }
}

/** A scaled bigint back to its decimal string, with exactly `scale` places ("20.3750"). */
export function formatScaled(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const unit = pow10(scale);
  const whole = abs / unit;
  const frac = abs % unit;
  const body = scale > 0 ? `${whole}.${frac.toString().padStart(scale, "0")}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/** A decimal string trimmed of trailing zeros after the point ("20.3750" -> "20.375", "1.5000" -> "1.5"). */
export function trimDecimal(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Integer division rounding half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new MoneyError("division by a non-positive number");
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (abs * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** An amount typed in major units ("160.00") as minor units of `currency`. */
export function toMinor(amount: string, currency: string): bigint {
  return parseDecimal(amount, currencyExponent(currency));
}

/** Minor units as a major-unit decimal string ("16000" USD -> "160.00"). */
export function minorToString(minor: bigint, currency: string): string {
  return formatScaled(minor, currencyExponent(currency));
}

/**
 * Pay for `seconds` of work at `rate` (scaled by RATE_SCALE) times `multiplier` (scaled by
 * MULTIPLIER_SCALE), in minor units of `currency`, rounded once.
 */
export function earningsMinor(seconds: number, rate: bigint, multiplier: bigint, currency: string): bigint {
  if (!Number.isInteger(seconds) || seconds < 0) throw new MoneyError("seconds must be a non-negative integer");
  const numerator = BigInt(seconds) * rate * multiplier * pow10(currencyExponent(currency));
  const denominator = 3600n * pow10(RATE_SCALE) * pow10(MULTIPLIER_SCALE);
  return roundDiv(numerator, denominator);
}

/** Sum of bigints. */
export const sumMinor = (values: Iterable<bigint>): bigint => {
  let total = 0n;
  for (const v of values) total += v;
  return total;
};

/**
 * A bigint that must fit in a JavaScript number without losing precision (seconds, counts).
 * Amounts stay bigint; this is for figures that are never money.
 */
export function safeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new MoneyError("value out of range");
  return Number(v);
}

/** Format a major-unit decimal string for display. Display only: the string is never used for arithmetic. */
export function formatMoney(amount: string | null | undefined, currency: string, locale?: string): string {
  if (amount === null || amount === undefined) return "—";
  try {
    // Intl.NumberFormat formats decimal strings exactly (no float conversion) where supported.
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}
