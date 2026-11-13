// Email addresses: validation, normalization and masking.

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

/** `a***z@example.com`: enough to recognise an address, not enough to collect it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const shown = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${shown}@${email.slice(at + 1)}`;
}
