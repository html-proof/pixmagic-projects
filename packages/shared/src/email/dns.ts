// Reading a domain's DNS for email: the ownership challenge, SPF, DKIM and DMARC. Pure parsing and
// judging; the lookups themselves are in packages/core (DNS over HTTPS).
//
// Results are reported as found, in plain words. Nothing here claims more than the record shows:
// a DKIM key being published says the provider *can* sign, not that a given message was signed.

export const VERIFY_HOST_PREFIX = "_insights-verify";
export const VERIFY_VALUE_PREFIX = "insights-verification=";

export interface DnsRecordInstruction {
  type: "TXT" | "CNAME";
  /** The full name, for DNS hosts that want it. */
  host: string;
  /** The name relative to the domain, for DNS hosts that add the domain themselves. */
  relativeHost: string;
  value: string;
  purpose: string;
}

export function verificationRecord(domain: string, token: string): DnsRecordInstruction {
  return {
    type: "TXT",
    host: `${VERIFY_HOST_PREFIX}.${domain}`,
    relativeHost: VERIFY_HOST_PREFIX,
    value: `${VERIFY_VALUE_PREFIX}${token}`,
    purpose: "Proves your business controls this domain. It doesn't change how your email works.",
  };
}

/** Which service sends this domain's mail: decides which SPF include and DKIM selectors to look for. */
export const SENDING_SERVICES = ["google", "microsoft", "other"] as const;
export type SendingService = (typeof SENDING_SERVICES)[number];

export const SENDING_SERVICE_INFO: Record<SendingService, { label: string; spfInclude: string | null; dkimSelectors: string[]; dkimHelp: string; spfHelp: string }> = {
  google: {
    label: "Google Workspace / Gmail",
    spfInclude: "_spf.google.com",
    dkimSelectors: ["google"],
    spfHelp: 'Your SPF record should include "include:_spf.google.com".',
    dkimHelp: "Generate the DKIM key in the Google Admin console (Apps → Google Workspace → Gmail → Authenticate email), publish it, then press Start authentication there.",
  },
  microsoft: {
    label: "Microsoft 365 / Outlook",
    spfInclude: "spf.protection.outlook.com",
    dkimSelectors: ["selector1", "selector2"],
    spfHelp: 'Your SPF record should include "include:spf.protection.outlook.com".',
    dkimHelp: "Publish the two CNAME records (selector1 and selector2) that the Microsoft Defender portal shows under Email authentication settings → DKIM, then enable signing there.",
  },
  other: {
    label: "Another email service (SMTP)",
    spfInclude: null,
    dkimSelectors: [],
    spfHelp: "Your SPF record should include the value your email service gives you (for example include:spf.yourprovider.com).",
    dkimHelp: "Your email service gives you a DKIM selector and a record to publish. Enter the selector here so bizinsights can check it.",
  },
};

export const DKIM_SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-_]{0,62})(?:\.[a-z0-9](?:[a-z0-9-_]{0,62}))*$/i;

/** DNS-over-HTTPS returns a TXT record as `"part one" "part two"`: the record is the parts joined. */
export function joinTxt(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data.trim();
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

export type CheckStatus = "pass" | "warn" | "fail" | "missing" | "unknown";

export interface CheckResult {
  status: CheckStatus;
  /** The record(s) found, for showing. */
  records: string[];
  /** What the result means, in plain words. */
  explanation: string;
}

/** The ownership challenge: does a TXT record at the challenge name hold this workspace's exact value? */
export function evaluateOwnership(txts: string[], expectedValue: string): CheckResult {
  const found = txts.filter((t) => t.startsWith(VERIFY_VALUE_PREFIX));
  if (txts.includes(expectedValue)) return { status: "pass", records: found, explanation: "The verification record is in place: this domain is verified for your workspace." };
  if (found.length) return { status: "fail", records: found, explanation: "A verification record exists, but its value doesn't match the one shown here. Copy the value again exactly." };
  return { status: "missing", records: [], explanation: "The verification record wasn't found yet. DNS changes can take from a few minutes to a few hours to appear." };
}

export interface SpfInfo {
  records: string[];
  includes: string[];
  /** The record's final `all` mechanism (`-all`, `~all`, `?all`, `+all`), if any. */
  all: string | null;
  redirect: string | null;
}

export function parseSpf(txts: string[]): SpfInfo {
  const records = txts.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const terms = (records[0] ?? "").trim().split(/\s+/).slice(1);
  return {
    records,
    includes: terms.filter((t) => /^[+?~-]?include:/i.test(t)).map((t) => t.replace(/^[+?~-]?include:/i, "").toLowerCase()),
    all: terms.find((t) => /^[+?~-]?all$/i.test(t)) ?? null,
    redirect: terms.find((t) => /^redirect=/i.test(t))?.slice(9).toLowerCase() ?? null,
  };
}

/**
 * Judge SPF for the domain's sending service. `includesSeen` is every include reachable from the
 * record (core follows nested includes, within SPF's own 10-lookup limit), so a record that
 * includes another record that includes Google's still counts.
 */
export function evaluateSpf(txts: string[], service: SendingService, includesSeen: string[]): CheckResult {
  const spf = parseSpf(txts);
  if (spf.records.length === 0) return { status: "missing", records: [], explanation: `No SPF record was found. ${SENDING_SERVICE_INFO[service].spfHelp}` };
  if (spf.records.length > 1) return { status: "fail", records: spf.records, explanation: "The domain has more than one SPF record, which makes SPF fail everywhere. Merge them into one." };
  if (spf.all === "+all" || spf.all === "all") return { status: "fail", records: spf.records, explanation: 'The SPF record ends in "+all", which lets anyone send as this domain. Use "~all" or "-all".' };
  const expected = SENDING_SERVICE_INFO[service].spfInclude;
  if (!expected) {
    return {
      status: "unknown",
      records: spf.records,
      explanation: "An SPF record exists. bizinsights can't tell which entry is your email service's, so check that it includes the value your provider gives you.",
    };
  }
  if (includesSeen.map((i) => i.toLowerCase()).includes(expected)) {
    return { status: "pass", records: spf.records, explanation: `The SPF record authorizes ${SENDING_SERVICE_INFO[service].label} to send for this domain.` };
  }
  return { status: "fail", records: spf.records, explanation: `The SPF record doesn't authorize ${SENDING_SERVICE_INFO[service].label}. ${SENDING_SERVICE_INFO[service].spfHelp}` };
}

export interface DkimKey {
  selector: string;
  /** What the selector's record says: a usable key, a revoked key (empty p=), or no DKIM record. */
  state: "key" | "revoked" | "missing" | "invalid";
  record: string | null;
}

export function parseDkim(selector: string, txts: string[]): DkimKey {
  const rec = txts.find((t) => /(^|;)\s*p=/i.test(t) || /^v=dkim1/i.test(t.trim()));
  if (!rec) return { selector, state: "missing", record: null };
  const tags = new Map(
    rec
      .split(";")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => [p.slice(0, p.indexOf("=")).trim().toLowerCase(), p.slice(p.indexOf("=") + 1).trim()] as const),
  );
  if (tags.has("v") && tags.get("v")!.toUpperCase() !== "DKIM1") return { selector, state: "invalid", record: rec };
  const p = tags.get("p");
  if (p === undefined) return { selector, state: "invalid", record: rec };
  if (p === "") return { selector, state: "revoked", record: rec };
  return /^[A-Za-z0-9+/=\s]{40,}$/.test(p) ? { selector, state: "key", record: rec } : { selector, state: "invalid", record: rec };
}

export function evaluateDkim(keys: DkimKey[], service: SendingService): CheckResult {
  const help = SENDING_SERVICE_INFO[service].dkimHelp;
  if (keys.length === 0) {
    return { status: "unknown", records: [], explanation: `bizinsights needs your DKIM selector to check it. ${help}` };
  }
  const shown = keys.filter((k) => k.record).map((k) => `${k.selector}: ${k.record!.slice(0, 120)}${k.record!.length > 120 ? "…" : ""}`);
  const good = keys.filter((k) => k.state === "key");
  if (good.length) {
    return {
      status: "pass",
      records: shown,
      explanation: `A DKIM public key is published for selector ${good.map((k) => `"${k.selector}"`).join(" and ")}. Your email service signs messages with the matching private key once signing is turned on there.`,
    };
  }
  if (keys.some((k) => k.state === "revoked")) return { status: "fail", records: shown, explanation: `The DKIM key is revoked (its p= value is empty). ${help}` };
  if (keys.some((k) => k.state === "invalid")) return { status: "fail", records: shown, explanation: `A DKIM record exists but isn't a valid key. ${help}` };
  return { status: "missing", records: [], explanation: `No DKIM key was found for selector ${keys.map((k) => `"${k.selector}"`).join(" or ")}. ${help}` };
}

export interface DmarcInfo {
  record: string | null;
  policy: "none" | "quarantine" | "reject" | null;
  reports: boolean;
}

export function parseDmarc(txts: string[]): DmarcInfo & { count: number } {
  const recs = txts.filter((t) => /^v=DMARC1(\s*;|$)/i.test(t.trim()));
  const rec = recs[0] ?? null;
  const tags = new Map(
    (rec ?? "")
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p.includes("="))
      .map((p) => [p.slice(0, p.indexOf("=")).trim().toLowerCase(), p.slice(p.indexOf("=") + 1).trim().toLowerCase()] as const),
  );
  const p = tags.get("p");
  return { record: rec, policy: p === "none" || p === "quarantine" || p === "reject" ? p : null, reports: tags.has("rua"), count: recs.length };
}

export function evaluateDmarc(txts: string[]): CheckResult {
  const d = parseDmarc(txts);
  if (!d.record) {
    return { status: "missing", records: [], explanation: 'No DMARC record was found at _dmarc. Add one, starting with "v=DMARC1; p=none; rua=mailto:you@yourdomain", and tighten the policy once SPF and DKIM pass.' };
  }
  if (d.count > 1) return { status: "fail", records: txts, explanation: "More than one DMARC record exists, so receivers ignore DMARC for this domain. Keep one." };
  if (!d.policy) return { status: "fail", records: [d.record], explanation: 'The DMARC record has no valid policy (p=none, quarantine or reject).' };
  if (d.policy === "none") {
    return { status: "warn", records: [d.record], explanation: "DMARC is present in monitoring mode (p=none): receivers report on your mail but don't act on failures. Move to quarantine or reject once SPF and DKIM pass." };
  }
  return { status: "pass", records: [d.record], explanation: `DMARC is enforced (p=${d.policy}): receivers ${d.policy === "reject" ? "refuse" : "quarantine"} mail that fails SPF and DKIM alignment.` };
}
