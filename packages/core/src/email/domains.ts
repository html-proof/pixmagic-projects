/**
 * Custom sending domains: proving the workspace controls a domain (a TXT challenge only it was
 * given), and reporting how the domain's email authentication (SPF, DKIM, DMARC) looks.
 *
 * The checks read public DNS and nothing else: bizinsights never writes DNS records, and reports only
 * what the records show. Ownership doesn't authorize anyone to send as Gmail or Microsoft addresses
 * at that domain; it lets an SMTP account's address at that domain become a verified sender (see
 * senders.ts), and it is the place to see whether mail from the domain will authenticate.
 */
import { createHash } from "node:crypto";
import { systemDb, withTenant, type EmailDomain } from "@app/db";
import {
  DOMAIN_CHALLENGE_DAYS,
  DOMAIN_RECHECK_GRACE,
  evaluateDkim,
  evaluateDmarc,
  evaluateOwnership,
  evaluateSpf,
  normalizeDomain,
  parseDkim,
  SENDING_SERVICE_INFO,
  verificationRecord,
  type CheckResult,
  type SendingService,
} from "@app/shared/email";
import { randomToken } from "@app/shared";
import { addressInDomain } from "@app/shared/email";
import { emailAudit, EmailError, isUniqueViolation, notFound, type EmailDeps } from "./common.js";
import { authorizeByDomain } from "./senders.js";
import { DnsLookupError, resolveDns, spfIncludesReachable } from "./dns.js";
import { AAD, open, seal } from "./vault.js";

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

/** How often a verified domain is rechecked, and a pending one looked at again. */
const RECHECK_VERIFIED_MS = 24 * 3600_000;
const RECHECK_PENDING_MS = 15 * 60_000;
const MAX_DOMAINS = 50;

export interface DnsResults {
  checkedAt: string;
  /** Set when DNS couldn't be read at all: nothing below is current. */
  error?: string;
  ownership?: CheckResult;
  spf?: CheckResult;
  dkim?: CheckResult;
  dmarc?: CheckResult;
}

const SERVICE = (s: string): SendingService => (s === "google" || s === "microsoft" ? s : "other");

/** The domain as the API shows it, with the records to publish. */
export function publicDomain(d: EmailDomain) {
  const token = open(d.verificationTokenEnc, AAD.domainToken(d.workspaceId, d.domain));
  const service = SERVICE(d.sendingService);
  const info = SENDING_SERVICE_INFO[service];
  const selectors = d.dkimSelectors.length ? d.dkimSelectors : info.dkimSelectors;
  return {
    id: d.id,
    domain: d.domain,
    status: d.verificationStatus,
    verifiedAt: d.ownershipVerifiedAt,
    challengeExpiresAt: d.verificationExpiresAt,
    sendingService: service,
    dkimSelectors: d.dkimSelectors,
    spf: d.spfStatus,
    dkim: d.dkimStatus,
    dmarc: d.dmarcStatus,
    lastCheckedAt: d.lastCheckedAt,
    nextCheckAt: d.nextCheckAt,
    results: (d.dnsResults ?? null) as unknown as DnsResults | null,
    records: {
      ownership: verificationRecord(d.domain, token),
      spf: { type: "TXT" as const, host: d.domain, relativeHost: "@", value: info.spfInclude ? `v=spf1 include:${info.spfInclude} ~all` : "v=spf1 include:<your provider's SPF domain> ~all", purpose: info.spfHelp },
      dkim: selectors.map((sel) => ({ type: (service === "microsoft" ? "CNAME" : "TXT") as "CNAME" | "TXT", host: `${sel}._domainkey.${d.domain}`, relativeHost: `${sel}._domainkey`, value: "Issued by your email service (copy it from there)", purpose: info.dkimHelp })),
      dmarc: { type: "TXT" as const, host: `_dmarc.${d.domain}`, relativeHost: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:dmarc@${d.domain}`, purpose: "Tells receivers what to do with mail that fails SPF and DKIM. Start with p=none, then move to quarantine or reject." },
    },
  };
}

export async function listDomains(workspaceId: string) {
  return withTenant(workspaceId, (tx) => tx.emailDomain.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }));
}

export async function getDomain(workspaceId: string, id: string) {
  const d = await withTenant(workspaceId, (tx) => tx.emailDomain.findFirst({ where: { id, workspaceId } }));
  if (!d) throw notFound();
  return d;
}

export async function addDomain(workspaceId: string, userId: string, input: { domain: string; sendingService: SendingService; dkimSelectors: string[] }) {
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new EmailError("Enter a public domain name, like example.com", 400, "invalid_domain");
  if ((await systemDb.emailDomain.count({ where: { workspaceId } })) >= MAX_DOMAINS) throw new EmailError(`A workspace can have at most ${MAX_DOMAINS} domains.`, 409, "too_many_domains");
  const token = randomToken(24);
  try {
    const d = await systemDb.emailDomain.create({
      data: {
        workspaceId,
        domain,
        verificationTokenHash: tokenHash(token),
        verificationTokenEnc: seal(token, AAD.domainToken(workspaceId, domain)),
        verificationExpiresAt: new Date(Date.now() + DOMAIN_CHALLENGE_DAYS * 86_400_000),
        sendingService: input.sendingService,
        dkimSelectors: input.dkimSelectors,
        nextCheckAt: new Date(Date.now() + RECHECK_PENDING_MS),
        createdByUserId: userId,
      },
    });
    await emailAudit({ workspaceId, actorUserId: userId, action: "email.domain.added", targetType: "email_domain", targetId: d.id, metadata: { domain } });
    return d;
  } catch (err) {
    if (isUniqueViolation(err)) throw new EmailError(`${domain} is already added.`, 409, "domain_exists");
    throw err;
  }
}

export async function updateDomain(workspaceId: string, id: string, userId: string, input: { sendingService?: SendingService; dkimSelectors?: string[] }) {
  const d = await getDomain(workspaceId, id);
  const updated = await systemDb.emailDomain.update({
    where: { id: d.id },
    data: { ...(input.sendingService ? { sendingService: input.sendingService } : {}), ...(input.dkimSelectors ? { dkimSelectors: input.dkimSelectors } : {}) },
  });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.domain.updated", targetType: "email_domain", targetId: d.id, metadata: input });
  return updated;
}

/** A new challenge (the old one expired, or was exposed). Verification starts over. */
export async function regenerateChallenge(workspaceId: string, id: string, userId: string) {
  const d = await getDomain(workspaceId, id);
  const token = randomToken(24);
  const updated = await systemDb.emailDomain.update({
    where: { id: d.id },
    data: {
      verificationTokenHash: tokenHash(token),
      verificationTokenEnc: seal(token, AAD.domainToken(workspaceId, d.domain)),
      verificationExpiresAt: new Date(Date.now() + DOMAIN_CHALLENGE_DAYS * 86_400_000),
      verificationStatus: d.verificationStatus === "verified" ? "verified" : "unverified",
      consecutiveFailures: 0,
      nextCheckAt: new Date(Date.now() + RECHECK_PENDING_MS),
    },
  });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.domain.challenge_regenerated", targetType: "email_domain", targetId: d.id });
  return updated;
}

export async function removeDomain(workspaceId: string, id: string, userId: string) {
  const d = await getDomain(workspaceId, id);
  // Senders that were authorized because of this domain lose that authorization with it.
  const revoked = await systemDb.emailSenderIdentity.updateMany({
    where: { workspaceId, domainId: d.id, verificationMethod: "domain_ownership", authorizationStatus: "verified" },
    data: { authorizationStatus: "pending", isDefault: false, domainId: null },
  });
  await systemDb.emailDomain.delete({ where: { id: d.id } });
  await emailAudit({ workspaceId, actorUserId: userId, action: "email.domain.removed", targetType: "email_domain", targetId: d.id, metadata: { domain: d.domain, sendersUnverified: revoked.count } });
  return { sendersUnverified: revoked.count };
}

/**
 * Look the domain up in public DNS and record what was found. Ownership moves through
 * unverified/pending/failed → verified, or → expired when the challenge runs out; a verified
 * domain whose record disappears goes to recheck_required, and after DOMAIN_RECHECK_GRACE failed
 * rechecks in a row to failed (and its domain-authorized senders stop being verified). When DNS
 * can't be read at all nothing changes but the error.
 */
export async function checkDomain(d: EmailDomain, deps: Pick<EmailDeps, "fetchImpl">): Promise<EmailDomain> {
  const now = new Date();
  const token = open(d.verificationTokenEnc, AAD.domainToken(d.workspaceId, d.domain));
  const expected = verificationRecord(d.domain, token).value;
  const service = SERVICE(d.sendingService);
  const selectors = d.dkimSelectors.length ? d.dkimSelectors : SENDING_SERVICE_INFO[service].dkimSelectors;
  let results: DnsResults;
  try {
    const [challengeTxt, rootTxt, dmarcTxt, dkimTxts] = await Promise.all([
      resolveDns(verificationRecord(d.domain, token).host, "TXT", deps.fetchImpl),
      resolveDns(d.domain, "TXT", deps.fetchImpl),
      resolveDns(`_dmarc.${d.domain}`, "TXT", deps.fetchImpl),
      Promise.all(selectors.map((sel) => resolveDns(`${sel}._domainkey.${d.domain}`, "TXT", deps.fetchImpl))),
    ]);
    const includes = await spfIncludesReachable(d.domain, deps.fetchImpl, rootTxt);
    results = {
      checkedAt: now.toISOString(),
      ownership: evaluateOwnership(challengeTxt, expected),
      spf: evaluateSpf(rootTxt, service, includes),
      dkim: evaluateDkim(selectors.map((sel, i) => parseDkim(sel, dkimTxts[i]!)), service),
      dmarc: evaluateDmarc(dmarcTxt),
    };
  } catch (err) {
    if (!(err instanceof DnsLookupError)) throw err;
    const prev = (d.dnsResults ?? {}) as unknown as DnsResults;
    return systemDb.emailDomain.update({
      where: { id: d.id },
      data: { lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + RECHECK_PENDING_MS), dnsResults: { ...prev, checkedAt: now.toISOString(), error: "DNS couldn't be read right now. bizinsights will try again shortly." } as never },
    });
  }

  const owned = results.ownership!.status === "pass";
  const wasVerified = d.verificationStatus === "verified" || d.verificationStatus === "recheck_required";
  let status: string;
  let failures = d.consecutiveFailures;
  let verifiedAt = d.ownershipVerifiedAt;
  if (owned) {
    status = "verified";
    failures = 0;
    verifiedAt ??= now;
  } else if (wasVerified) {
    failures++;
    status = failures >= DOMAIN_RECHECK_GRACE ? "failed" : "recheck_required";
  } else if (d.verificationExpiresAt < now) {
    status = "expired";
  } else {
    status = results.ownership!.status === "fail" ? "failed" : "pending";
  }
  const settled = status === "verified" || status === "recheck_required";
  const updated = await systemDb.emailDomain.update({
    where: { id: d.id },
    data: {
      verificationStatus: status,
      ownershipVerifiedAt: status === "failed" || status === "expired" ? null : verifiedAt,
      consecutiveFailures: failures,
      spfStatus: results.spf!.status,
      dkimStatus: results.dkim!.status,
      dmarcStatus: results.dmarc!.status,
      dnsResults: results as never,
      lastCheckedAt: now,
      nextCheckAt: status === "expired" ? null : new Date(now.getTime() + (settled ? RECHECK_VERIFIED_MS : status === "failed" && wasVerified ? RECHECK_VERIFIED_MS : RECHECK_PENDING_MS)),
    },
  });
  if (status !== d.verificationStatus) {
    await emailAudit({ workspaceId: d.workspaceId, action: "email.domain.status_changed", targetType: "email_domain", targetId: d.id, metadata: { domain: d.domain, from: d.verificationStatus, to: status } });
    // Newly verified: SMTP senders at this domain whose accounts work become verified with it.
    if (status === "verified") {
      const pending = await systemDb.emailSenderIdentity.findMany({ where: { workspaceId: d.workspaceId, authorizationStatus: "pending" }, include: { account: true } });
      for (const s of pending) {
        if (!s.account.deletedAt && addressInDomain(s.senderEmail, d.domain)) await authorizeByDomain(d.workspaceId, s, s.account);
      }
    }
    if (wasVerified && status === "failed") {
      await systemDb.emailSenderIdentity.updateMany({
        where: { workspaceId: d.workspaceId, domainId: d.id, verificationMethod: "domain_ownership", authorizationStatus: "verified" },
        data: { authorizationStatus: "pending", isDefault: false },
      });
    }
  }
  return updated;
}
