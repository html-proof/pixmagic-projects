/**
 * Structured JSON logger (one line per entry) with a pino-like call shape:
 * `logger.info({ ...fields }, "message")`. CloudWatch Logs Insights reads the JSON fields.
 * Sensitive keys are redacted at any depth.
 *
 * Fields set with `withLogContext` (the API's request id, a queue job's id) are added to every
 * line written inside that call, so one request's lines can be found together without passing
 * the id to every function that logs.
 */
import { AsyncLocalStorage } from "node:async_hooks";

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
    "sessionToken",
    // SMTP logins (nodemailer's auth.pass), CloudFront's origin secret, API keys, AWS keys, PKCE
    // verifiers, Google Ads' developer token header and Meta's signed requests.
    "pass",
    "x-origin-verify",
    "apiKey",
    "api_key",
    "x-api-key",
    "developer-token",
    "secretAccessKey",
    "codeVerifier",
    "code_verifier",
    "signed_request",
    // WhatsApp: the customer's number and the merchant's credentials.
    "x-hub-signature-256",
    "phone",
    "wa_id",
    "waId",
    "pin",
    "verifyToken",
    "verify_token",
    "hub.verify_token",
    // Evolution API (what is left of QR linking until release 2): instance keys, webhook signing keys, QR codes, message texts.
    "apikey",
    "token",
    "jwt_key",
    "jwtKey",
    "webhookKey",
    "qrcode",
    "base64",
    "pairingCode",
    "remoteJid",
    "ownerJid",
    "wuid",
    "text",
  ].map((k) => k.toLowerCase()),
);

/**
 * Credentials and personal data that can turn up inside free text (an error message, a URL):
 * Shopify tokens and secrets, bearer credentials, our API keys, Google and AWS credentials, JWTs,
 * OAuth parameters in a query string, and email addresses (kept recognisable for debugging: first
 * character and domain).
 */
const SCRUB: Array<[RegExp, string]> = [
  [/\bshp(?:at|ua|ca|ss|pa)_[A-Za-z0-9]+/g, "[redacted]"],
  [/\b(?:sk|ek)_live_[A-Za-z0-9_-]+/g, "[redacted]"],
  // Meta access tokens (user, business and system-user tokens all start with EA).
  [/\bEA[A-Za-z0-9]{40,}/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  // Google access and refresh tokens, Resend keys, AWS access key ids, any JWT (Cognito's ID token).
  [/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]"],
  [/(^|[^A-Za-z0-9])1\/\/[A-Za-z0-9._-]{20,}/g, "$1[redacted]"],
  [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g, "[redacted]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  // A URL's OAuth and credential parameters (a provider error that quotes the request it refused).
  [/([?&](?:code|access_token|refresh_token|id_token|client_secret|fb_exchange_token|code_verifier|token|key|signature)=)[^&\s"']+/gi, "$1[redacted]"],
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

/**
 * An error's own identifying fields, kept beside its message: a Prisma or Node error `code`
 * (P2002, ECONNRESET), an HTTP `status`. Logged as `errorCode` because `code` is redacted (it is
 * also the name of an OAuth authorization code). Only short strings and numbers are kept.
 */
function errorDetails(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const e = err as Error & { code?: unknown; status?: unknown; statusCode?: unknown };
  if ((typeof e.code === "string" && e.code.length <= 64) || typeof e.code === "number") out.errorCode = typeof e.code === "string" ? scrub(e.code) : e.code;
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
  if (status !== undefined) out.status = status;
  return out;
}

/** What a log entry's fields look like once secrets are removed (exported for tests). */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrub(value.message),
      ...errorDetails(value),
      stack: value.stack === undefined ? undefined : scrub(value.stack),
      // What the error wraps (a driver error inside Prisma's, a fetch failure inside ours).
      ...(value.cause !== undefined && depth < 3 ? { cause: redactForLog(value.cause, depth + 1) } : {}),
    };
  }
  if (!value || typeof value !== "object") return value;
  // Deeper than this is never worth logging, and returning it as is would skip redaction.
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redactForLog(v, depth + 1);
  return out;
}

const context = new AsyncLocalStorage<Record<string, unknown>>();

/**
 * Run `fn` with `fields` added to every log line written inside it (nested calls add to the
 * outer fields). The fields are not redacted, so pass identifiers only, never credentials or
 * personal data.
 */
export function withLogContext<T>(fields: Record<string, unknown>, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

/** The current log context itself (the same object for the whole request, job or tick), if any. */
export function currentLogContext(): Readonly<Record<string, unknown>> | undefined {
  return context.getStore();
}

/** Add fields to the current log context, e.g. the user once a request has authenticated. */
export function addLogContext(fields: Record<string, unknown>): void {
  const store = context.getStore();
  if (store) Object.assign(store, fields);
}

function write(level: Exclude<Level, "silent">, a: unknown, b?: string) {
  if (ORDER[level] < threshold()) return;
  const redacted = typeof a === "string" ? {} : redactForLog(a);
  const fields: Record<string, unknown> =
    redacted === null || redacted === undefined ? {} : typeof redacted === "object" && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : { value: redacted };
  const msg = typeof a === "string" ? scrub(a) : b === undefined ? undefined : scrub(b);
  // A field may not replace the entry's own level or message: a `msg` field is kept as `detail`.
  const { level: _level, msg: fieldMsg, ...rest } = fields;
  const line = JSON.stringify({ level, msg, ...context.getStore(), ...rest, ...(fieldMsg === undefined ? {} : { detail: fieldMsg }) });
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
