// Where an SMTP account may connect: the outbound policy that keeps "Connect custom SMTP" from
// becoming a way to make Insights' servers talk to private networks, cloud metadata services or
// itself (SSRF). packages/core resolves the host and checks every address with isBlockedAddress
// before connecting; the ports and TLS modes are fixed here.

import { SMTP_PORTS, type SmtpEncryption } from "./constants";

export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255 || (p.length > 1 && p.startsWith("0"))) return null;
    out.push(n);
  }
  return out;
}

/** 16 bytes, or null. Accepts `::` compression and an embedded IPv4 tail; rejects zone ids. */
export function parseIPv6(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, "");
  if (s.includes("%") || !s.includes(":")) return null;
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const parsed = parseIPv4(v4[1]!);
    if (!parsed) return null;
    tail = parsed;
    s = `${s.slice(0, -v4[1]!.length)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string) => (h === "" ? [] : h.split(":"));
  const head = words(halves[0]!);
  const rest = halves.length === 2 ? words(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.length !== 8) return null;
  const bytes: number[] = [];
  for (const w of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
    const n = parseInt(w, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

const inV4 = (ip: number[], base: number[], bits: number) => {
  for (let i = 0; i < 4; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((ip[i]! & mask) !== (base[i]! & mask)) return false;
  }
  return true;
};

const V4_BLOCKS: Array<[number[], number, string]> = [
  [[0, 0, 0, 0], 8, "this network"],
  [[10, 0, 0, 0], 8, "private network"],
  [[100, 64, 0, 0], 10, "carrier-grade NAT"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link-local / cloud metadata"],
  [[172, 16, 0, 0], 12, "private network"],
  [[192, 0, 0, 0], 24, "IETF protocol assignments"],
  [[192, 0, 2, 0], 24, "documentation"],
  [[192, 88, 99, 0], 24, "6to4 relay"],
  [[192, 168, 0, 0], 16, "private network"],
  [[198, 18, 0, 0], 15, "benchmarking"],
  [[198, 51, 100, 0], 24, "documentation"],
  [[203, 0, 113, 0], 24, "documentation"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

function v4Blocked(ip: number[]): string | null {
  for (const [base, bits, why] of V4_BLOCKS) if (inV4(ip, base, bits)) return why;
  return null;
}

const prefix = (b: number[], hex: string, bits: number) => {
  const want = parseIPv6(hex)!;
  for (let i = 0; i < 16; i++) {
    const take = Math.max(0, Math.min(8, bits - i * 8));
    if (take === 0) return true;
    const mask = (0xff << (8 - take)) & 0xff;
    if ((b[i]! & mask) !== (want[i]! & mask)) return false;
  }
  return true;
};

function v6Blocked(b: number[]): string | null {
  if (b.every((x) => x === 0)) return "unspecified address";
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses reach an IPv4 host: judge that host.
  if (prefix(b, "::ffff:0:0", 96) || prefix(b, "64:ff9b::", 96)) return v4Blocked(b.slice(12));
  if (prefix(b, "::", 96)) return "IPv4-compatible address";
  if (prefix(b, "100::", 64)) return "discard prefix";
  if (prefix(b, "2001:db8::", 32)) return "documentation";
  if (prefix(b, "2001::", 23)) return "IETF protocol assignments";
  if (prefix(b, "2002::", 16)) return "6to4";
  if (prefix(b, "fc00::", 7)) return "private network (unique local)";
  if (prefix(b, "fe80::", 10)) return "link-local";
  if (prefix(b, "fec0::", 10)) return "site-local";
  if (prefix(b, "ff00::", 8)) return "multicast";
  return null;
}

/** Why an address may not be connected to, or null when it is a public unicast address. */
export function blockedAddressReason(ip: string): string | null {
  const v4 = parseIPv4(ip);
  if (v4) return v4Blocked(v4);
  const v6 = parseIPv6(ip);
  if (v6) return v6Blocked(v6);
  return "not an IP address";
}

export const isIpLiteral = (host: string) => parseIPv4(host) !== null || parseIPv6(host) !== null;

/** Names that only ever mean something inside a private network. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".test", ".invalid", ".example", ".localdomain", ".home.arpa", ".onion"];

/**
 * First check of an SMTP host, before any DNS lookup: a well-formed public DNS name, or a public IP
 * address. `null` means it may be looked up (and every address it resolves to is checked again).
 */
export function smtpHostProblem(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253) return "invalid_host";
  if (isIpLiteral(h)) return blockedAddressReason(h) ? "blocked_destination" : null;
  if (h === "localhost" || PRIVATE_SUFFIXES.some((s) => h.endsWith(s)) || h === "metadata.google.internal") return "blocked_destination";
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l)) || !/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(labels[labels.length - 1]!)) return "invalid_host";
  return null;
}

/** The encryption a port must use, or a problem. There is no unencrypted option. */
export function smtpPortProblem(port: number, mode: SmtpEncryption): string | null {
  const expected = SMTP_PORTS[port];
  if (!expected) return `Port ${port} isn't supported. Use 465 (TLS), 587 or 2525 (STARTTLS).`;
  if (expected !== mode) return `Port ${port} uses ${expected === "tls" ? "TLS" : "STARTTLS"}.`;
  return null;
}
