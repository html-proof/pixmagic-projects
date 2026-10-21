// Email addresses and domains: validation, normalization and masking.

/**
 * A practical address check (the dot-atom form every mailbox provider actually issues), not all
 * of RFC 5322: no quoted local parts, comments or IP literals. Nothing that could break a header
 * (spaces, quotes, angle brackets, CR/LF) can pass.
 */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$/;

export const isEmail = (s: unknown): s is string => typeof s === "string" && s.length <= 254 && EMAIL_RE.test(s) && !s.includes("..") && !s.startsWith(".") && !s.split("@")[0]!.endsWith(".");

/** Trimmed and lowercased, or null when it isn't an address. Lowercasing the local part is what every major provider does in practice. */
export function normalizeEmail(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  return isEmail(t) ? t : null;
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/** `a***z@example.com`: enough to recognise an address, not enough to collect it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const shown = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${shown}@${email.slice(at + 1)}`;
}

/** No line breaks or NULs: the value can't add or end a header. */
export const headerSafe = (s: string) => !/[\r\n\0]/.test(s);

/** A display name: one line, at most 100 characters. */
export const displayNameOk = (s: string) => headerSafe(s) && s.trim().length > 0 && s.length <= 100;

/** Top-level names that never belong to a public mail domain. */
const PRIVATE_TLDS = new Set(["localhost", "local", "internal", "lan", "home", "corp", "intranet", "test", "invalid", "example", "onion", "arpa", "localdomain"]);

/**
 * A sending domain from whatever was typed (`Example.com`, `https://example.com/`, `user@example.com`):
 * lowercased, punycoded, without a scheme, path, port or trailing dot. Null when it can't be a
 * public DNS name (an IP address, a single label, a private top-level name).
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0]!.replace(/\.$/, "");
  if (/:\d+$/.test(s)) s = s.replace(/:\d+$/, "");
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname;
  } catch {
    return null;
  }
  if (!host || host.length > 253 || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld) || PRIVATE_TLDS.has(tld)) return null;
  return host;
}

/** Whether `email` is at `domain` or one of its subdomains. */
export function addressInDomain(email: string, domain: string): boolean {
  const d = emailDomain(email);
  return d === domain || d.endsWith(`.${domain}`);
}
