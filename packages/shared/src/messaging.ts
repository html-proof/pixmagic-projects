/**
 * What WhatsApp and Customer Messaging (SMS) share: phone numbers as customers type them, and
 * sending hours in a store's time zone. Pure functions, safe in the browser
 * (`@app/shared/messaging`).
 */

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/**
 * Calling code and national trunk prefix per ISO country. A number typed without "+" is only
 * turned into an international one when its country is known here: guessing would send a
 * customer's order details to a stranger. `trunk` is what a local number starts with that the
 * international form drops ("0412 345 678" in AU → +61 412 345 678); Italy keeps its 0.
 */
const COUNTRIES: Record<string, { code: string; trunk?: string; len?: [number, number] }> = {
  AE: { code: "971", trunk: "0", len: [8, 9] },
  AR: { code: "54", trunk: "0", len: [10, 11] },
  AT: { code: "43", trunk: "0", len: [4, 13] },
  AU: { code: "61", trunk: "0", len: [9, 9] },
  BD: { code: "880", trunk: "0", len: [10, 10] },
  BE: { code: "32", trunk: "0", len: [8, 9] },
  BH: { code: "973", len: [8, 8] },
  BR: { code: "55", trunk: "0", len: [10, 11] },
  CA: { code: "1", trunk: "1", len: [10, 10] },
  CH: { code: "41", trunk: "0", len: [9, 9] },
  CL: { code: "56", len: [9, 9] },
  CN: { code: "86", trunk: "0", len: [10, 11] },
  CO: { code: "57", len: [10, 10] },
  DE: { code: "49", trunk: "0", len: [6, 13] },
  DK: { code: "45", len: [8, 8] },
  EG: { code: "20", trunk: "0", len: [9, 10] },
  ES: { code: "34", len: [9, 9] },
  FI: { code: "358", trunk: "0", len: [5, 12] },
  FR: { code: "33", trunk: "0", len: [9, 9] },
  GB: { code: "44", trunk: "0", len: [9, 10] },
  GH: { code: "233", trunk: "0", len: [9, 9] },
  GR: { code: "30", len: [10, 10] },
  HK: { code: "852", len: [8, 8] },
  ID: { code: "62", trunk: "0", len: [9, 12] },
  IE: { code: "353", trunk: "0", len: [7, 9] },
  IL: { code: "972", trunk: "0", len: [8, 9] },
  IN: { code: "91", trunk: "0", len: [10, 10] },
  IT: { code: "39", len: [6, 11] },
  JP: { code: "81", trunk: "0", len: [9, 10] },
  KE: { code: "254", trunk: "0", len: [9, 9] },
  KR: { code: "82", trunk: "0", len: [8, 10] },
  KW: { code: "965", len: [8, 8] },
  LK: { code: "94", trunk: "0", len: [9, 9] },
  MX: { code: "52", len: [10, 10] },
  MY: { code: "60", trunk: "0", len: [8, 10] },
  NG: { code: "234", trunk: "0", len: [8, 10] },
  NL: { code: "31", trunk: "0", len: [9, 9] },
  NO: { code: "47", len: [8, 8] },
  NP: { code: "977", trunk: "0", len: [8, 10] },
  NZ: { code: "64", trunk: "0", len: [8, 10] },
  OM: { code: "968", len: [8, 8] },
  PE: { code: "51", len: [8, 9] },
  PH: { code: "63", trunk: "0", len: [9, 10] },
  PK: { code: "92", trunk: "0", len: [9, 10] },
  PL: { code: "48", len: [9, 9] },
  PT: { code: "351", len: [9, 9] },
  QA: { code: "974", len: [8, 8] },
  RO: { code: "40", trunk: "0", len: [9, 9] },
  SA: { code: "966", trunk: "0", len: [8, 9] },
  SE: { code: "46", trunk: "0", len: [7, 9] },
  SG: { code: "65", len: [8, 8] },
  TH: { code: "66", trunk: "0", len: [8, 9] },
  TR: { code: "90", trunk: "0", len: [10, 10] },
  TW: { code: "886", trunk: "0", len: [8, 9] },
  UA: { code: "380", trunk: "0", len: [9, 9] },
  US: { code: "1", trunk: "1", len: [10, 10] },
  VN: { code: "84", trunk: "0", len: [9, 10] },
  ZA: { code: "27", trunk: "0", len: [9, 9] },
};

/** Countries whose numbers can be typed without "+" (a country picker's choices). */
export const PHONE_COUNTRIES: readonly string[] = Object.keys(COUNTRIES);
/** A country's calling code ("61" for AU), or null when we don't know its rules. */
export const callingCode = (country: string): string | null => COUNTRIES[country.toUpperCase()]?.code ?? null;

/** Where countries share a calling code, the one a number is said to be from. */
const SHARED_CODE_COUNTRY: Record<string, string> = { "1": "US" };

/** Calling codes we can map back to a country (longest code first, so "971" wins over "97"). */
const BY_CODE = Object.entries(COUNTRIES)
  .map(([iso, c]) => ({ iso, code: c.code }))
  .filter((v) => (SHARED_CODE_COUNTRY[v.code] ?? v.iso) === v.iso)
  .filter((v, i, a) => a.findIndex((w) => w.code === v.code) === i)
  .sort((a, b) => b.code.length - a.code.length);

export interface NormalizedPhone {
  /** E.164 without the plus sign, as the Cloud API's `to` and webhooks' `wa_id` use it. */
  waId: string;
  /** "+61412345678". */
  e164: string;
  /** ISO country of the number, when its calling code is one we know. */
  country: string | null;
}

/**
 * A phone number as a customer typed it into a checkout, as an international number, or null
 * when that can't be done with confidence: an international number with 8 to 15 digits, or a
 * local one whose country (the shipping or billing address's) we know the rules for.
 */
export function normalizePhone(raw: string | null | undefined, country?: string | null): NormalizedPhone | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || /[a-z]/i.test(trimmed.replace(/(ext|x)\.?\s*\d+$/i, ""))) return null;
  const noExt = trimmed.replace(/\s*(ext|x)\.?\s*\d+$/i, "");
  let digits = noExt.replace(/[^\d+]/g, "");
  let international = false;
  if (digits.startsWith("+")) {
    international = true;
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    international = true;
    digits = digits.slice(2);
  }
  if (digits.includes("+") || !/^\d+$/.test(digits)) return null;
  if (!international) {
    const c = country ? COUNTRIES[country.toUpperCase()] : undefined;
    if (!c) return null;
    const [min, max] = c.len ?? [6, 13];
    const fits = (n: string) => n.length >= min && n.length <= max;
    const strip = (prefix: string | undefined) => (prefix && digits.startsWith(prefix) && fits(digits.slice(prefix.length)) ? digits.slice(prefix.length) : null);
    // "0412 345 678" (trunk prefix), "61412345678" (country code typed without "+"), "412345678".
    // Where the country dials a trunk prefix, a local number typed without it is rarer than one
    // typed with the country code, so the code is tried first there; elsewhere (Italy, Spain),
    // the number as typed is.
    const national = c.trunk ? (strip(c.trunk) ?? strip(c.code) ?? (fits(digits) ? digits : null)) : ((fits(digits) ? digits : null) ?? strip(c.code));
    if (!national) return null;
    // North American numbers never start their area code or exchange with 0 or 1: "0412 345 678"
    // with a US store is an Australian number typed locally, not +1 041 234 5678.
    if (c.code === "1" && !/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
    digits = c.code + national;
  }
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return { waId: digits, e164: `+${digits}`, country: countryOfWaId(digits) };
}

/** The ISO country a number's calling code belongs to, when it is one we know. */
export function countryOfWaId(waId: string): string | null {
  const hit = BY_CODE.find((c) => waId.startsWith(c.code));
  return hit?.iso ?? null;
}

/** "+61 •••• •••• 678": enough for the merchant to tell numbers apart, nothing more. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const hit = BY_CODE.find((c) => digits.startsWith(c.code));
  const cc = hit ? hit.code : digits.slice(0, Math.min(3, digits.length - 4));
  const rest = digits.slice(cc.length);
  const tail = rest.slice(-3);
  return `+${cc} ${"•".repeat(Math.max(2, rest.length - 3))} ${tail}`;
}

/**
 * "+61412345678" → "+61 412 345 678": the whole number, its calling code apart and the rest in
 * groups of three or four, so it reads like a number and not a code. Anything that isn't an
 * international number comes back as it was.
 */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (!e164.trim().startsWith("+") || digits.length < 8 || digits.length > 15) return e164.trim();
  const cc = callingCodeOf(digits);
  const rest = digits.slice(cc.length);
  const groups: string[] = [];
  let at = 0;
  for (const n of groupSizes(rest.length)) {
    groups.push(rest.slice(at, at + n));
    at += n;
  }
  return `+${cc} ${groups.join(" ")}`;
}

/**
 * Every calling code shorter than three digits (ITU-T E.164: 1 and 7, and these two-digit ones). The
 * codes are prefix-free, so any other number's code is its first three digits, whether or not we
 * know its country's local rules (Russia's +7 isn't in COUNTRIES and must still read "+7 …").
 */
const SHORT_CALLING_CODES = new Set([
  "1", "7",
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66",
  "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98",
]);

/** The calling code an international number (digits only, no "+") starts with. */
function callingCodeOf(digits: string): string {
  if (SHORT_CALLING_CODES.has(digits.slice(0, 1))) return digits.slice(0, 1);
  if (SHORT_CALLING_CODES.has(digits.slice(0, 2))) return digits.slice(0, 2);
  return digits.slice(0, 3);
}

/**
 * Whether the customer typed the calling code themselves ("+61…", "0061…", "61412…"), rather than it
 * being added from a country ("0412 345 678" read as Australian). An extension doesn't count.
 */
export function phoneCodeTyped(raw: string, e164: string): boolean {
  const digits = raw.replace(/\s*(ext|x)\.?\s*\d+$/i, "").replace(/\D/g, "").replace(/^00/, "");
  return digits === e164.replace(/\D/g, "");
}

/** 9 → 3 3 3, 10 → 3 3 4, 8 → 4 4, 11 → 3 4 4, 7 → 3 4. */
function groupSizes(n: number): number[] {
  if (n <= 4) return [n];
  if (n === 5) return [2, 3];
  const tail = n % 3 === 0 ? [] : n % 3 === 1 ? [4] : [4, 4];
  const head = Array<number>((n - tail.reduce((a, b) => a + b, 0)) / 3).fill(3);
  return [...head, ...tail];
}

/**
 * Where a customer's phone number was found in Shopify: their own profile, an address they typed
 * at a checkout, their default address, or their last order. Only the profile's number carries
 * Shopify's text-message consent.
 */
export const CUSTOMER_PHONE_SOURCES = ["customer", "checkout_shipping", "checkout_billing", "default_address", "last_order", "last_order_shipping", "last_order_billing"] as const;
export type CustomerPhoneSource = (typeof CUSTOMER_PHONE_SOURCES)[number];

export const CUSTOMER_PHONE_SOURCE_LABEL: Record<CustomerPhoneSource, string> = {
  customer: "From their customer profile",
  checkout_shipping: "Typed at checkout (delivery address)",
  checkout_billing: "Typed at checkout (billing address)",
  default_address: "From their saved address",
  last_order: "From their last order",
  last_order_shipping: "From their last order's delivery address",
  last_order_billing: "From their last order's billing address",
};

export interface PhoneCandidate<S extends string = string> {
  raw: string | null | undefined;
  /** The country the number was typed in (its address's), used for a number without "+". */
  country?: string | null;
  source: S;
}

export interface BestPhone<S extends string = string> {
  /** The international number, or null when it can't be read as one (no country code, too short). */
  e164: string | null;
  /** The number as the customer typed it. */
  raw: string;
  source: S;
  /** The calling code came from `fallbackCountry` (the store's): not typed, and not from its address. */
  countryAssumed: boolean;
}

/**
 * The best phone number among the places a customer's number can be, in the order given: the first
 * that reads as an international number with its own country, else the first that does with the
 * store's country (said to be assumed), else the first one typed at all (shown as typed, with no
 * international form). Null when no candidate has any digits.
 */
export function bestPhone<S extends string>(candidates: ReadonlyArray<PhoneCandidate<S>>, fallbackCountry?: string | null): BestPhone<S> | null {
  const typed = candidates.map((c) => ({ ...c, raw: c.raw?.trim() ?? "" })).filter((c) => /\d/.test(c.raw));
  for (const c of typed) {
    const n = normalizePhone(c.raw, c.country);
    if (n) return { e164: n.e164, raw: c.raw, source: c.source, countryAssumed: false };
  }
  if (fallbackCountry) {
    for (const c of typed) {
      const n = normalizePhone(c.raw, fallbackCountry);
      // "61412345678" needs a country only to be read: its code was typed, nothing was assumed.
      if (n) return { e164: n.e164, raw: c.raw, source: c.source, countryAssumed: !phoneCodeTyped(c.raw, n.e164) };
    }
  }
  const first = typed[0];
  return first ? { e164: null, raw: first.raw, source: first.source, countryAssumed: false } : null;
}

// ---------------------------------------------------------------------------
// Sending hours (store time)
// ---------------------------------------------------------------------------

/** The hour and minute of `at` in a time zone (0-23). */
export function zonedHour(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { hour: get("hour") % 24, minute: get("minute") };
}

/** Whether `at` falls inside [start, end) in the store's time zone (a window may wrap midnight). */
export function inSendWindow(at: Date, timeZone: string, start: number, end: number): boolean {
  if (start === end) return true;
  const { hour } = zonedHour(at, timeZone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** The earliest moment at or after `at` that is inside the window (to the minute). */
export function nextSendTime(at: Date, timeZone: string, start: number, end: number): Date {
  if (inSendWindow(at, timeZone, start, end)) return at;
  const { hour, minute } = zonedHour(at, timeZone);
  let hoursAhead = (start - hour + 24) % 24;
  if (hoursAhead === 0) hoursAhead = 24;
  const t = new Date(at.getTime() + hoursAhead * 3600_000 - minute * 60_000);
  t.setUTCSeconds(0, 0);
  // Time-zone transitions can land an hour off; step forward until inside.
  for (let i = 0; i < 3 && !inSendWindow(t, timeZone, start, end); i++) t.setTime(t.getTime() + 3600_000);
  return t;
}
