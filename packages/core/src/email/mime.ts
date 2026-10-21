/**
 * The message itself (RFC 5322 + MIME): headers and a multipart/alternative body with a plain-text
 * and an HTML part. Gmail and Microsoft Graph take this as-is, and the SMTP client sends it after
 * DATA, so every provider sends the same bytes: our Message-ID, List-Unsubscribe and all.
 *
 * Header values that could carry a line break are refused rather than cleaned: a CR/LF in a
 * subject or a name is how header injection works, and it never belongs there.
 */
import { randomBytes } from "node:crypto";
import { headerSafe, isEmail } from "@app/shared/email";

export interface MimeInput {
  from: { email: string; name?: string | null };
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Without angle brackets: `<id>@<host>`. */
  messageId: string;
  date?: Date;
  /** Extra headers (List-Unsubscribe and friends). Names are fixed by the caller, values checked here. */
  headers?: Record<string, string>;
}

export class MimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeError";
  }
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 2047 encoded-words for non-ASCII header text, each under the 75-character limit. */
function encodeWords(value: string): string {
  if (ASCII_PRINTABLE.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const ch of value) {
    // 45 bytes of UTF-8 encode to 60 base64 characters: well inside one encoded word.
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** `"Name" <addr>` with the name quoted or encoded as needed; just `addr` without a name. */
export function formatAddress(email: string, name?: string | null): string {
  if (!isEmail(email)) throw new MimeError("Invalid email address");
  if (!name) return email;
  if (!headerSafe(name)) throw new MimeError("Invalid display name");
  if (!ASCII_PRINTABLE.test(name)) return `${encodeWords(name)} <${email}>`;
  return `"${name.replace(/["\\]/g, "\\$&")}" <${email}>`;
}

/** RFC 5322 date: `Tue, 14 Oct 2026 10:00:00 +0000`. */
function rfc5322Date(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]}, ${p(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

/** Base64 in 76-character lines, as MIME bodies are written. */
function base64Lines(s: string): string {
  return (Buffer.from(s, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

const crlf = (s: string) => s.replace(/\r\n|\r|\n/g, "\r\n");

export function buildMime(m: MimeInput): string {
  if (!isEmail(m.to)) throw new MimeError("Invalid recipient address");
  if (m.replyTo && !isEmail(m.replyTo)) throw new MimeError("Invalid reply-to address");
  if (!headerSafe(m.subject)) throw new MimeError("The subject contains a line break");
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/.test(m.messageId)) throw new MimeError("Invalid Message-ID");
  for (const [name, value] of Object.entries(m.headers ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || !headerSafe(value) || !ASCII_PRINTABLE.test(value)) throw new MimeError(`Invalid header ${name}`);
  }
  const boundary = `=_insights_${randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${formatAddress(m.from.email, m.from.name)}`,
    `To: ${m.to}`,
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Subject: ${encodeWords(m.subject)}`,
    `Date: ${rfc5322Date(m.date ?? new Date())}`,
    `Message-ID: <${m.messageId}>`,
    "MIME-Version: 1.0",
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", base64Lines(crlf(body))].join("\r\n");
  return [...headers, "", part("text/plain", m.text), part("text/html", m.html), `--${boundary}--`, ""].join("\r\n");
}

/** Gmail's `raw`: the message in base64url. */
export const base64Url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
