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

// ---------------------------------------------------------------------------
// Sending hours (store time)
// ---------------------------------------------------------------------------

function zonedHour(at: Date, timeZone: string): { hour: number; minute: number } {
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
