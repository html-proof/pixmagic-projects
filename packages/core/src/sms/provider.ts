/**
 * The SMS provider, behind an interface like the mailer and the queues: AWS End User Messaging
 * SMS on AWS (apps/aws/src/smsProvider.ts, the pinpoint-sms-voice-v2 API), a fake in tests and on
 * the local server, and "not configured" anywhere else. Core never names the vendor's SDK.
 */
import type { SenderType } from "@app/shared/sms";

export interface SmsSendRequest {
  region: string;
  /** E.164, "+61412345678". */
  destination: string;
  body: string;
  originationIdentity: string;
  messageType: "TRANSACTIONAL" | "PROMOTIONAL";
  configurationSet?: string | null;
  /** US dollars for the whole message ("0.25000"): AWS refuses a dearer route instead of sending. */
  maxPrice?: string | null;
  /** Seconds the carrier may keep trying (AWS's default is 72 hours). */
  ttlSeconds?: number;
  /** Logged with every delivery event: how an event finds its message (job and workspace ids, never personal data). */
  context: Record<string, string>;
  /** India: the DLT entity and template ids. */
  dlt?: { entityId: string; templateId: string } | null;
  /** AWS checks the request and sends nothing (no charge). */
  dryRun?: boolean;
}

export interface SmsSendResult {
  messageId: string;
}

/**
 * A refused or broken call. `type` is AWS's exception name (ThrottlingException,
 * ConflictException…), or "network" / "timeout" when there was no answer; `reason` its Reason
 * field. `notSent`: the request never left this machine, so trying again can't duplicate it.
 */
export class SmsProviderError extends Error {
  constructor(
    public type: string,
    public reason: string | null,
    public status: number | null,
    public notSent: boolean,
    message: string,
  ) {
    super(message);
    this.name = "SmsProviderError";
  }
}

export interface SmsIdentityInfo {
  kind: SenderType;
  arn: string;
  id: string;
  /** The sender ID itself, or the number masked. */
  label: string;
  country: string | null;
  /** AWS's status (ACTIVE, PENDING…), or "REGISTERED"/"UNREGISTERED" for a sender ID. */
  status: string | null;
  twoWay: boolean;
  optOutList: string | null;
  /** Whether AWS has its registration as complete; null when it needs none or AWS didn't say. */
  registrationStatus: string | null;
  tags: Record<string, string>;
}

export interface SmsAccountInfo {
  /** ACCOUNT_TIER: "SANDBOX"-like values until AWS grants production access. */
  tier: string;
  sandbox: boolean;
  /** TEXT_MESSAGE_MONTHLY_SPEND_LIMIT in force, and the most it may be set to (US$). */
  spendLimitUsd: number | null;
  spendLimitMaxUsd: number | null;
}

export interface SmsOptedOutNumber {
  e164: string;
  at: Date;
}

export interface SmsProvider {
  readonly name: "aws" | "fake" | "none";
  send(req: SmsSendRequest): Promise<SmsSendResult>;
  account(region: string): Promise<SmsAccountInfo>;
  /** The origination identity (ARN or id), or null when AWS has none by that name. */
  identity(region: string, identity: string, country?: string | null): Promise<SmsIdentityInfo | null>;
  /** Numbers on an opt-out list (STOP replies, numbers opted out by hand in the AWS console), newest first. */
  optedOut(region: string, optOutList: string, since: Date | null): Promise<SmsOptedOutNumber[]>;
  /** AWS's sandbox verification of a test number: create it, send it a code, check the code. */
  createVerifiedNumber(region: string, e164: string, tags: Record<string, string>): Promise<{ id: string; status: string }>;
  sendVerificationCode(region: string, verifiedId: string, originationIdentity: string | null, configurationSet: string | null): Promise<void>;
  verifyNumber(region: string, verifiedId: string, code: string): Promise<{ status: string }>;
  deleteVerifiedNumber(region: string, verifiedId: string): Promise<void>;
}

const notConfigured = () => new SmsProviderError("NotConfigured", null, null, true, "SMS isn't configured in this environment");

/** Where no provider is wired (scripts, a test that doesn't care): every call refuses without sending. */
export const noSmsProvider: SmsProvider = {
  name: "none",
  send: async () => {
    throw notConfigured();
  },
  account: async () => ({ tier: "NOT_CONFIGURED", sandbox: true, spendLimitUsd: null, spendLimitMaxUsd: null }),
  identity: async () => null,
  optedOut: async () => [],
  createVerifiedNumber: async () => {
    throw notConfigured();
  },
  sendVerificationCode: async () => {
    throw notConfigured();
  },
  verifyNumber: async () => {
    throw notConfigured();
  },
  deleteVerifiedNumber: async () => {},
};

export interface FakeSent extends SmsSendRequest {
  messageId: string;
}

/**
 * An in-memory AWS for tests and the local server: records every send, hands out message ids,
 * knows the identities and opt-outs it was given, and can be told to fail the next sends
 * (`failNext`). The verification code it "texts" is always the one in `verificationCode`.
 */
export function fakeSmsProvider(o: { identities?: SmsIdentityInfo[]; account?: Partial<SmsAccountInfo>; onSend?: (sent: FakeSent) => void } = {}) {
  const sent: FakeSent[] = [];
  const identities = new Map<string, SmsIdentityInfo>();
  for (const i of o.identities ?? []) {
    identities.set(i.arn, i);
    identities.set(i.id, i);
  }
  const failures: SmsProviderError[] = [];
  const optOuts: SmsOptedOutNumber[] = [];
  const verified = new Map<string, { e164: string; status: string }>();
  let n = 0;
  const provider: SmsProvider & {
    sent: FakeSent[];
    identities: Map<string, SmsIdentityInfo>;
    optOuts: SmsOptedOutNumber[];
    verified: Map<string, { e164: string; status: string }>;
    verificationCode: string;
    failNext(...errors: SmsProviderError[]): void;
    accountInfo: SmsAccountInfo;
    clear(): void;
  } = {
    name: "fake",
    sent,
    identities,
    optOuts,
    verified,
    verificationCode: "123456",
    accountInfo: { tier: "SANDBOX", sandbox: true, spendLimitUsd: 1, spendLimitMaxUsd: 1, ...o.account },
    failNext(...errors) {
      failures.push(...errors);
    },
    clear() {
      sent.length = 0;
      failures.length = 0;
      optOuts.length = 0;
      verified.clear();
    },
    async send(req) {
      const failure = failures.shift();
      if (failure) throw failure;
      if (!identities.has(req.originationIdentity)) throw new SmsProviderError("ResourceNotFoundException", null, 400, false, "origination identity not found");
      if (optOuts.some((x) => x.e164 === req.destination)) throw new SmsProviderError("ConflictException", "DESTINATION_PHONE_NUMBER_OPTED_OUT", 400, false, "opted out");
      const messageId = `fake-${++n}-${Date.now().toString(36)}`;
      const record = { ...req, messageId };
      sent.push(record);
      o.onSend?.(record);
      return { messageId };
    },
    async account() {
      return provider.accountInfo;
    },
    async identity(_region, identity) {
      return identities.get(identity) ?? null;
    },
    async optedOut(_region, _list, since) {
      return optOuts.filter((x) => !since || x.at > since);
    },
    async createVerifiedNumber(_region, e164) {
      const id = `verified-${++n}`;
      verified.set(id, { e164, status: "PENDING" });
      return { id, status: "PENDING" };
    },
    async sendVerificationCode(_region, verifiedId) {
      if (!verified.has(verifiedId)) throw new SmsProviderError("ResourceNotFoundException", null, 400, false, "no such verified number");
    },
    async verifyNumber(_region, verifiedId, code) {
      const v = verified.get(verifiedId);
      if (!v) throw new SmsProviderError("ResourceNotFoundException", null, 400, false, "no such verified number");
      if (code !== provider.verificationCode) throw new SmsProviderError("ValidationException", "INVALID_VERIFICATION_CODE", 400, false, "wrong code");
      v.status = "VERIFIED";
      return { status: "VERIFIED" };
    },
    async deleteVerifiedNumber(_region, verifiedId) {
      verified.delete(verifiedId);
    },
  };
  return provider;
}

export type FakeSmsProvider = ReturnType<typeof fakeSmsProvider>;
