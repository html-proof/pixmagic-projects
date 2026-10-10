/**
 * Structured JSON logger (one line per entry) with a pino-like call shape:
 * `logger.info({ ...fields }, "message")`. Workers Logs indexes the JSON fields.
 * Sensitive keys are redacted at any depth.
 */
type Level = "debug" | "info" | "warn" | "error" | "silent";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const REDACT = new Set([
  "authorization",
  "cookie",
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "idToken",
  "code",
  "customToken",
  "sessionCookie",
  "client_secret",
  "clientSecret",
  "appSecret",
  "developerToken",
  "fb_exchange_token",
]);

function threshold(): number {
  const env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {};
  const lvl = (env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info")) as Level;
  return ORDER[lvl] ?? ORDER.info;
}

function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (!value || typeof value !== "object" || depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.has(k) ? "[redacted]" : clean(v, depth + 1);
  return out;
}

function write(level: Exclude<Level, "silent">, a: unknown, b?: string) {
  if (ORDER[level] < threshold()) return;
  const fields = typeof a === "string" ? {} : (clean(a) as Record<string, unknown>);
  const msg = typeof a === "string" ? a : b;
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
