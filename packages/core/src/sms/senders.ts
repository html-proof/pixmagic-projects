/**
 * A store's sender: which AWS origination identity it texts from, where to, within what budget,
 * and on what basis order updates go out. Also what AWS says about the account (still in the SMS
 * sandbox? what spending limit?) and the team's own test numbers.
 *
 * Origination identities live in bizinsights' AWS account, so a store may only use one that AWS
 * tags for its workspace (`bizinsights:workspace=<id>`), or the platform's shared one
 * (`bizinsights:shared=true`, and named in SMS_SHARED_SENDER). The tag is set by the platform
 * owner when they register the identity (docs/sms.md, "Registering a sender"), so no store can
 * send as another store's brand by typing its ARN.
 */
import { systemDb, type SmsSenderConfiguration, type Store } from "@app/db";
import { maskPhone, normalizePhone } from "@app/shared";
import { COUNTRY_RULES, senderIdSupport, type SmsSenderInput } from "@app/shared/sms";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { configurationSetFor, smsAudit, smsEncrypt, SmsError, smsMode, smsPhoneHash, smsRegion, type SmsDeps } from "./common.js";
import { SmsProviderError, type SmsAccountInfo, type SmsIdentityInfo } from "./provider.js";
import type { Actor } from "./templates.js";

export const WORKSPACE_TAG = "bizinsights:workspace";
export const SHARED_TAG = "bizinsights:shared";

/** Whether an identity may be used by a workspace: tagged for it, or the platform's shared sender. */
export function identityAllowed(info: SmsIdentityInfo, workspaceId: string, requested: string): boolean {
  if (info.tags[WORKSPACE_TAG] === workspaceId) return true;
  const shared = env().SMS_SHARED_SENDER.trim();
  return info.tags[SHARED_TAG] === "true" && !!shared && (shared === requested || shared === info.arn || shared === info.id);
}

/** The region a sender's countries need (India's local routes are only in Mumbai/Hyderabad). */
export function regionForCountries(countries: string[]): string {
  if (countries.includes("IN")) return COUNTRY_RULES.IN!.region;
  return smsRegion(null);
}

/** Save the sender's settings. Changing the identity or region sets it back to unchecked (and sending off) until it is verified again. */
export async function saveSender(store: Pick<Store, "id" | "workspaceId">, input: SmsSenderInput, actor: Actor): Promise<SmsSenderConfiguration> {
  if (input.countries.includes("IN") && input.countries.some((c) => c !== "IN")) {
    throw new SmsError("India's local routes need a sender of their own in the Mumbai region: use a separate store sender for India.", 400, "india_separate");
  }
  const region = regionForCountries(input.countries);
  const before = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  const identityChanged = !before || before.originationIdentity !== input.originationIdentity || before.awsRegion !== region;
  const basisChanged = (before?.transactionalBasis ?? "none") !== input.transactionalBasis;
  const data = {
    senderType: input.senderType,
    originationIdentity: input.originationIdentity,
    awsRegion: region,
    configurationSet: configurationSetFor(region),
    countries: [...new Set(input.countries)],
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    hardStop: input.hardStop,
    monthlyMessageQuota: input.monthlyMessageQuota ?? null,
    transactionalBasis: input.transactionalBasis,
    ...(basisChanged ? { transactionalBasisBy: actor.userId, transactionalBasisAt: new Date() } : {}),
    quietStart: input.quietStart,
    quietEnd: input.quietEnd,
    maxPerCustomerDay: input.maxPerCustomerDay,
    maxMarketingPerWeek: input.maxMarketingPerWeek,
    dltEntityId: input.dltEntityId ?? null,
    updatedBy: actor.userId,
    ...(identityChanged ? { identityCheck: "unchecked", identityCheckedAt: null, identityLabel: null, identityStatus: null, identityCountry: null, registrationStatus: "unknown", sendingEnabled: false, marketingEnabled: false } : {}),
  };
  const saved = await systemDb.smsSenderConfiguration.upsert({
    where: { storeId: store.id },
    create: { workspaceId: store.workspaceId, storeId: store.id, ...data },
    update: data,
  });
  await smsAudit({
    workspaceId: store.workspaceId,
    storeId: store.id,
    actorUserId: actor.userId,
    action: before ? "sender_updated" : "sender_created",
    targetType: "sms_sender",
    targetId: saved.id,
    snapshot: { ...input, awsRegion: region },
    metadata: basisChanged ? { transactionalBasis: input.transactionalBasis } : undefined,
    ip: actor.ip,
  });
  return saved;
}

const REGISTERED = new Set(["COMPLETE", "REGISTERED", "ACTIVE"]);

/**
 * Ask AWS about the sender's origination identity and record what it says: whether it exists in
 * this region, may be used by this workspace (its tags), its status and registration. Sending can
 * only be turned on once this has passed.
 */
export async function verifySender(store: Pick<Store, "id" | "workspaceId">, deps: Pick<SmsDeps, "sms">, actor: Actor | null): Promise<SmsSenderConfiguration> {
  const s = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  if (!s) throw new SmsError("Set up the sender first.", 409, "no_sender");
  let check: string;
  let info: SmsIdentityInfo | null = null;
  try {
    info = await deps.sms.identity(s.awsRegion, s.originationIdentity, s.countries[0] ?? null);
    check = !info ? "not_found" : identityAllowed(info, store.workspaceId, s.originationIdentity) ? "verified" : "not_allowed";
  } catch (err) {
    logger.warn({ err, storeId: store.id }, "sms identity check failed");
    check = "error";
  }
  // A sender ID AWS reports no registration for still needs one where the country requires it (AWS only says so for some).
  const reported = info?.registrationStatus ?? (info?.kind === "sender_id" && senderIdSupport(info.country) === "registered" ? "REQUIRED" : null);
  const registration = reported ? (REGISTERED.has(reported.toUpperCase()) ? "complete" : /REVIEW|SUBMITTED|PROVISIONING|CREATED/i.test(reported) ? "in_review" : "required") : info ? "not_required" : "unknown";
  const updated = await systemDb.smsSenderConfiguration.update({
    where: { id: s.id },
    data: {
      identityCheck: check,
      identityCheckedAt: new Date(),
      identityLabel: info?.label ?? null,
      identityCountry: info?.country ?? null,
      identityStatus: info?.status ?? null,
      twoWay: info?.twoWay ?? false,
      optOutList: info?.optOutList ?? s.optOutList,
      registrationStatus: registration,
      configurationSet: configurationSetFor(s.awsRegion),
      // A sender that no longer checks out stops sending.
      ...(check !== "verified" ? { sendingEnabled: false, marketingEnabled: false } : {}),
      ...(check === "verified" && s.heldReason === "sender_not_found" ? { heldUntil: null, heldReason: null } : {}),
    },
  });
  if (actor) await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "sender_verified", targetType: "sms_sender", targetId: s.id, metadata: { result: check, registration }, ip: actor.ip });
  return updated;
}

/** Turn sending (or marketing) on or off. On needs a verified identity, a budget and a basis for order updates or marketing on. */
export async function setSending(store: Pick<Store, "id" | "workspaceId">, o: { sending?: boolean; marketing?: boolean }, actor: Actor): Promise<SmsSenderConfiguration> {
  const s = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  if (!s) throw new SmsError("Set up the sender first.", 409, "no_sender");
  if (o.sending || o.marketing) {
    if (s.identityCheck !== "verified") throw new SmsError("Check the sender first (Sender configuration → Check sender).", 409, "sender_unverified");
    if (!(Number(s.monthlyBudgetUsd) > 0)) throw new SmsError("Set a monthly budget first: nothing is sent with a budget of 0.", 409, "no_budget");
  }
  if (o.marketing && !(o.sending ?? s.sendingEnabled)) throw new SmsError("Turn sending on first.", 409, "sending_off");
  const updated = await systemDb.smsSenderConfiguration.update({
    where: { id: s.id },
    data: {
      ...(o.sending !== undefined ? { sendingEnabled: o.sending } : {}),
      ...(o.marketing !== undefined ? { marketingEnabled: o.marketing } : {}),
      ...(o.sending === false ? { marketingEnabled: false } : {}),
      updatedBy: actor.userId,
    },
  });
  if (o.sending === false) {
    // Texts waiting to go are not kept for a later "on": the merchant turned sending off.
    await systemDb.smsMessageJob.updateMany({ where: { storeId: store.id, status: "scheduled", purpose: { not: "test" } }, data: { status: "cancelled", reason: "sending_disabled", finalAt: new Date(), valuesEnc: null } });
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "sending_changed", targetType: "sms_sender", targetId: s.id, metadata: o, ip: actor.ip });
  return updated;
}

export interface Readiness {
  mode: "off" | "sandbox" | "live";
  marketingSwitch: boolean;
  account: SmsAccountInfo | null;
  accountError: boolean;
  configurationSet: string | null;
  sender: SmsSenderConfiguration | null;
}

/** What stands between the store and texting customers: the platform's mode, AWS's account state, the sender. */
export async function readiness(store: Pick<Store, "id">, deps: Pick<SmsDeps, "sms">): Promise<Readiness> {
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  const region = smsRegion(sender);
  let account: SmsAccountInfo | null = null;
  let accountError = false;
  if (smsMode() !== "off") {
    try {
      account = await deps.sms.account(region);
    } catch (err) {
      accountError = true;
      logger.warn({ err }, "sms account check failed");
    }
  }
  return { mode: smsMode(), marketingSwitch: /^(1|true|yes|on)$/i.test(env().SMS_MARKETING_ENABLED.trim()), account, accountError, configurationSet: configurationSetFor(region), sender };
}

// ---------------------------------------------------------------------------
// Test numbers: a phone the member holds, proven by a code texted to it (AWS's sandbox delivers
// only to numbers verified with it; on Twilio bizinsights texts and checks the code itself)
// ---------------------------------------------------------------------------

function providerMessage(err: unknown, what: string): SmsError {
  if (err instanceof SmsProviderError) {
    if (err.type === "NotConfigured") return new SmsError("SMS isn't switched on for bizinsights yet.", 409, "platform_off");
    if (err.type === "ValidationException" && /EXPIRED/i.test(err.reason ?? "")) return new SmsError("That code has expired. Send a new one and enter it within 10 minutes.", 400, "code_expired");
    if (err.type === "ValidationException" && /CODE/i.test(err.reason ?? "")) return new SmsError("That code isn't right. Check the latest text and try again.", 400, "wrong_code");
    if (/NO_ORIGINATION_IDENTITIES_FOUND/.test(err.reason ?? "")) return new SmsError("Check your SMS sender first (Sender configuration): the code is texted from it.", 409, "sender_unverified");
    if (err.type === "ServiceQuotaExceededException") return new SmsError("The SMS provider's limit on test numbers is reached. Remove one you no longer use.", 409, "quota");
    if (err.type === "ThrottlingException") return new SmsError("The SMS provider asked to slow down. Try again in a minute.", 429, "throttled");
  }
  logger.warn({ err }, `sms ${what} failed`);
  return new SmsError(`The SMS provider couldn't ${what} right now. Try again in a few minutes.`, 409, "provider_error");
}

/** Add a test number: it is texted a code, which the member types in to verify it. */
export async function addTestNumber(store: Pick<Store, "id" | "workspaceId">, raw: string, country: string | null, deps: Pick<SmsDeps, "sms">, actor: Actor) {
  if (smsMode() === "off") throw new SmsError("SMS isn't switched on for bizinsights yet, so no code can be texted.", 409, "platform_off");
  const phone = normalizePhone(raw, country);
  if (!phone) throw new SmsError("Enter a mobile number with its country code, such as +61 412 345 678.", 400, "invalid_number");
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  const region = smsRegion(sender);
  const hash = smsPhoneHash(store.id, phone.e164);
  const count = await systemDb.smsTestNumber.count({ where: { storeId: store.id } });
  if (count >= 5) throw new SmsError("A store can have 5 test numbers. Remove one first.", 409, "too_many_test_numbers");
  let row = await systemDb.smsTestNumber.findUnique({ where: { storeId_phoneHash: { storeId: store.id, phoneHash: hash } } });
  try {
    if (!row || !row.awsVerifiedId) {
      const created = await deps.sms.createVerifiedNumber(region, phone.e164, { [WORKSPACE_TAG]: store.workspaceId });
      row = row
        ? await systemDb.smsTestNumber.update({ where: { id: row.id }, data: { awsVerifiedId: created.id, status: created.status === "VERIFIED" ? "verified" : "pending" } })
        : await systemDb.smsTestNumber.create({
            data: { workspaceId: store.workspaceId, storeId: store.id, phoneHash: hash, phoneEnc: smsEncrypt(store.id, "test_phone", phone.e164), phoneMasked: maskPhone(phone.e164), country: phone.country, awsVerifiedId: created.id, status: created.status === "VERIFIED" ? "verified" : "pending", createdBy: actor.userId },
          });
    }
    if (row.status !== "verified") await deps.sms.sendVerificationCode(region, row.awsVerifiedId!, sender?.identityCheck === "verified" ? sender.originationIdentity : null, configurationSetFor(region), phone.e164);
  } catch (err) {
    throw providerMessage(err, "send a verification code");
  }
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "test_number_added", targetType: "sms_test_number", targetId: row.id, metadata: { number: row.phoneMasked }, ip: actor.ip });
  return row;
}

export async function verifyTestNumber(store: Pick<Store, "id" | "workspaceId">, id: string, code: string, deps: Pick<SmsDeps, "sms">, actor: Actor) {
  const row = await systemDb.smsTestNumber.findFirst({ where: { id, storeId: store.id } });
  if (!row || !row.awsVerifiedId) throw new SmsError("Test number not found.", 404, "not_found");
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  try {
    const r = await deps.sms.verifyNumber(smsRegion(sender), row.awsVerifiedId, code.trim());
    if (r.status !== "VERIFIED") throw new SmsError("That code isn't right. Check the latest text and try again.", 400, "wrong_code");
  } catch (err) {
    if (err instanceof SmsError) throw err;
    throw providerMessage(err, "check the code");
  }
  const updated = await systemDb.smsTestNumber.update({ where: { id }, data: { status: "verified", verifiedAt: new Date() } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "test_number_verified", targetType: "sms_test_number", targetId: id, metadata: { number: row.phoneMasked }, ip: actor.ip });
  return updated;
}

export async function removeTestNumber(store: Pick<Store, "id" | "workspaceId">, id: string, deps: Pick<SmsDeps, "sms">, actor: Actor) {
  const row = await systemDb.smsTestNumber.findFirst({ where: { id, storeId: store.id } });
  if (!row) throw new SmsError("Test number not found.", 404, "not_found");
  const sender = await systemDb.smsSenderConfiguration.findUnique({ where: { storeId: store.id } });
  if (row.awsVerifiedId) await deps.sms.deleteVerifiedNumber(smsRegion(sender), row.awsVerifiedId).catch((err: unknown) => logger.warn({ err }, "sms verified number delete failed"));
  await systemDb.smsTestNumber.delete({ where: { id } });
  await smsAudit({ workspaceId: store.workspaceId, storeId: store.id, actorUserId: actor.userId, action: "test_number_removed", targetType: "sms_test_number", targetId: id, metadata: { number: row.phoneMasked }, ip: actor.ip });
}
