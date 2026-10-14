/**
 * DNS lookups over HTTPS (the resolvers' JSON API), the only way a Worker can ask DNS. Used for the
 * domain checks and to vet an SMTP host's addresses before connecting to it.
 */
import { joinTxt, parseSpf } from "@app/shared/email";
import { env } from "../env.js";
import type { FetchLike } from "../shopify.js";

export type DnsType = "A" | "AAAA" | "TXT" | "CNAME" | "MX";
const TYPE_CODE: Record<DnsType, number> = { A: 1, AAAA: 28, TXT: 16, CNAME: 5, MX: 15 };

/** The resolver couldn't answer (SERVFAIL, a timeout, a network error): nothing is known, either way. */
export class DnsLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsLookupError";
  }
}

const FALLBACK_DOH = "https://dns.google/resolve";
const TIMEOUT_MS = 5_000;

async function query(base: string, name: string, type: DnsType, fetchImpl: FetchLike): Promise<string[]> {
  const url = `${base}?${new URLSearchParams({ name, type })}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new DnsLookupError(`DNS lookup failed: ${(err as Error).message}`);
  }
  if (!res.ok) throw new DnsLookupError(`DNS resolver returned ${res.status}`);
  const body = (await res.json().catch(() => null)) as { Status?: number; Answer?: Array<{ type: number; data: string }> } | null;
  if (!body || typeof body.Status !== "number") throw new DnsLookupError("DNS resolver sent an unreadable answer");
  // 3 = NXDOMAIN: the name doesn't exist, which is an answer ("nothing there").
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new DnsLookupError(`DNS lookup failed (status ${body.Status})`);
  return (body.Answer ?? []).filter((a) => a.type === TYPE_CODE[type]).map((a) => (type === "TXT" ? joinTxt(a.data) : a.data.replace(/\.$/, "")));
}

/** Records of one type at a name; [] when there are none. Throws DnsLookupError when no resolver answers. */
export async function resolveDns(name: string, type: DnsType, fetchImpl: FetchLike): Promise<string[]> {
  try {
    return await query(env().EMAIL_DOH_URL, name, type, fetchImpl);
  } catch (err) {
    if (!(err instanceof DnsLookupError) || env().EMAIL_DOH_URL === FALLBACK_DOH) throw err;
    return query(FALLBACK_DOH, name, type, fetchImpl);
  }
}

/** Every address a host resolves to (IPv4 and IPv6). */
export async function resolveAddresses(host: string, fetchImpl: FetchLike): Promise<string[]> {
  const [a, aaaa] = await Promise.all([resolveDns(host, "A", fetchImpl), resolveDns(host, "AAAA", fetchImpl)]);
  return [...a, ...aaaa];
}

/**
 * Every include (and redirect) reachable from a domain's SPF record, following nested records up to
 * SPF's own limit of 10 lookups. A record that includes another that includes Google's still counts.
 */
export async function spfIncludesReachable(domain: string, fetchImpl: FetchLike, rootTxts?: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const queue: Array<{ name: string; txts?: string[] }> = [{ name: domain, txts: rootTxts }];
  let lookups = 0;
  while (queue.length && lookups < 10) {
    const next = queue.shift()!;
    let txts = next.txts;
    if (!txts) {
      lookups++;
      txts = await resolveDns(next.name, "TXT", fetchImpl).catch(() => []);
    }
    const spf = parseSpf(txts);
    for (const inc of [...spf.includes, ...(spf.redirect ? [spf.redirect] : [])]) {
      if (seen.has(inc)) continue;
      seen.add(inc);
      queue.push({ name: inc });
    }
  }
  return [...seen];
}
