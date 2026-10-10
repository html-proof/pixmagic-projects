/**
 * Structured JSON logger (one line per entry) with a pino-like call shape:
 * `logger.info({ ...fields }, "message")`. Workers Logs indexes the JSON fields.
 * Sensitive keys are redacted at any depth.
 */
type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Keys whose values never reach a log line, compared case-insensitively (header names vary). */
const REDACT = new Set(
  [
    "authorization",
    "cookie",
    "set-cookie",
    "access_token",
    "refresh_token",
    "accessToken",
    "refreshToken",
    "idToken",
    "id_token",
    "token",
    "code",
    "oobCode",
    "otp",
    "customToken",
    "sessionCookie",
    "password",
    "secret",
    "clientSecret",
    "client_secret",
    "apiSecret",
    "appSecret",
    "developerToken",
    "fb_exchange_token",
    "privateKey",
    "private_key",
    "assertion",
    "pepper",
    "hmac",
    "x-shopify-access-token",
    "x-shopify-hmac-sha256",
    // WhatsApp: the customer's number and the merchant's credentials.
    "x-hub-signature-256",
    "phone",
    "wa_id",
    "waId",
    "pin",
    "verifyToken",
    "verify_token",
    "hub.verify_token",
  ].map((k) => k.toLowerCase()),
);

/**
 * Credentials and personal data that can turn up inside free text (an error message, a URL):
 * Shopify tokens and secrets, bearer credentials, our API keys, and email addresses (kept
 * recognisable for debugging: first character and domain).
 */
const SCRUB: Array<[RegExp, string]> = [
  [/\bshp(?:at|ua|ca|ss|pa)_[A-Za-z0-9]+/g, "[redacted]"],
  [/\bsk_live_[A-Za-z0-9_-]+/g, "[redacted]"],
  // Meta access tokens (user, business and system-user tokens all start with EA).
  [/\bEA[A-Za-z0-9]{40,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "$1***@$2"],
];

function scrub(s: string): string {
  return SCRUB.reduce((out, [re, to]) => out.replace(re, to), s);
}

function threshold(): number {
  const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
  const lvl = (env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info")) as Level;
  return ORDER[lvl] ?? ORDER.info;
}

/** What a log entry's fields look like once secrets are removed (exported for tests). */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message), stack: value.stack === undefined ? undefined : scrub(value.stack) };
  }
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redactForLog(v, depth + 1);
  return out;
}

function write(level: Exclude<Level, "silent">, a: unknown, b?: string) {
  if (ORDER[level] < threshold()) return;
  const fields = typeof a === "string" ? {} : (redactForLog(a) as Record<string, unknown>);
  const msg = typeof a === "string" ? scrub(a) : b === undefined ? undefined : scrub(b);
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const logger: Logger = {
  debug: (a, b) => write("debug", a, b),
  info: (a, b) => write("info", a, b),
  warn: (a, b) => write("warn", a, b),
  error: (a, b) => write("error", a, b),
};
