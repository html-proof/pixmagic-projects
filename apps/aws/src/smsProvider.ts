import { AwsClient } from "aws4fetch";
import type { FetchLike } from "@app/core";
import { SmsProviderError, type SmsAccountInfo, type SmsIdentityInfo, type SmsOptedOutNumber, type SmsProvider, type SmsSendRequest } from "@app/core/sms";
import type { AwsCredentials } from "./awsClient.js";

/**
 * AWS End User Messaging SMS (the pinpoint-sms-voice-v2 API: SendTextMessage and the Describe*
 * calls) for core/sms. Signed JSON calls with the function role's credentials through aws4fetch,
 * as SQS, SES and DynamoDB are here: the same API the AWS SDK calls, without the SDK's cold-start
 * cost. The region is per call: Indian local routes are only in ap-south-1/ap-south-2.
 *
 * Nothing here logs: core decides what to record, and never the number or the text.
 */
export interface SmsProviderOptions {
  credentials: AwsCredentials;
  fetchImpl?: FetchLike;
}

interface AwsErrorBody {
  __type?: string;
  message?: string;
  Message?: string;
  Reason?: string;
  reason?: string;
}

/** Connection failures where the request never reached AWS: trying again can't send twice. */
const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

function networkError(err: unknown): SmsProviderError {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") return new SmsProviderError("timeout", null, null, false, "AWS didn't answer in time");
  const code = e?.code ?? e?.cause?.code ?? "";
  return new SmsProviderError("network", code || null, null, NOT_SENT.has(code), `AWS unreachable (${code || "network"})`);
}

export function awsSmsProvider(o: SmsProviderOptions): SmsProvider {
  const fetchImpl = o.fetchImpl ?? fetch;
  const signers = new Map<string, AwsClient>();
  const signer = (region: string) => {
    let s = signers.get(region);
    if (!s) {
      s = new AwsClient({ ...o.credentials, service: "sms-voice", region });
      signers.set(region, s);
    }
    return s;
  };

  async function call<T>(region: string, operation: string, body: Record<string, unknown>): Promise<T> {
    const endpoint = `https://sms-voice.${region}.amazonaws.com/`;
    let res: Response;
    try {
      const signed = await signer(region).sign(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `PinpointSMSVoiceV2.${operation}` },
        body: JSON.stringify(body),
      });
      res = await fetchImpl(signed.url, { method: "POST", headers: signed.headers, body: await signed.text() });
    } catch (err) {
      throw networkError(err);
    }
    const text = await res.text().catch(() => "");
    let json: T & AwsErrorBody;
    try {
      json = (text ? JSON.parse(text) : {}) as T & AwsErrorBody;
    } catch {
      json = {} as T & AwsErrorBody;
    }
    if (!res.ok) {
      const type = (json.__type ?? res.headers.get("x-amzn-errortype") ?? "").split("#").pop()?.split(":")[0] || (res.status >= 500 ? "InternalServerException" : `http_${res.status}`);
      const reason = json.Reason ?? json.reason ?? null;
      throw new SmsProviderError(type, reason, res.status, false, `${operation} failed (${res.status} ${type}${reason ? ` ${reason}` : ""})`);
    }
    return json;
  }

  const notFound = (err: unknown) => err instanceof SmsProviderError && err.type === "ResourceNotFoundException";

  async function tags(region: string, arn: string): Promise<Record<string, string>> {
    const r = await call<{ Tags?: Array<{ Key: string; Value: string }> }>(region, "ListTagsForResource", { ResourceArn: arn });
    return Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value]));
  }

  async function registrationStatus(region: string, id: string | undefined): Promise<string | null> {
    if (!id) return null;
    const r = await call<{ Registrations?: Array<{ RegistrationStatus?: string }> }>(region, "DescribeRegistrations", { RegistrationIds: [id] }).catch(() => ({ Registrations: [] }));
    return r.Registrations?.[0]?.RegistrationStatus ?? null;
  }

  const NUMBER_KIND: Record<string, SmsIdentityInfo["kind"]> = { TOLL_FREE: "toll_free", TEN_DLC: "ten_dlc", SHORT_CODE: "short_code", LONG_CODE: "long_code", SIMULATOR: "long_code" };

  return {
    name: "aws",

    async send(req: SmsSendRequest) {
      const body: Record<string, unknown> = {
        DestinationPhoneNumber: req.destination,
        OriginationIdentity: req.originationIdentity,
        MessageBody: req.body,
        MessageType: req.messageType,
        Context: req.context,
      };
      if (req.configurationSet) body.ConfigurationSetName = req.configurationSet;
      if (req.maxPrice) body.MaxPrice = req.maxPrice;
      if (req.ttlSeconds) body.TimeToLive = Math.max(5, Math.min(259_200, Math.round(req.ttlSeconds)));
      if (req.dlt) body.DestinationCountryParameters = { IN_ENTITY_ID: req.dlt.entityId, IN_TEMPLATE_ID: req.dlt.templateId };
      if (req.dryRun) body.DryRun = true;
      const r = await call<{ MessageId?: string }>(req.region, "SendTextMessage", body);
      // A 200 without an id is a broken answer, not a refusal: AWS may have the text.
      if (!r.MessageId) throw new SmsProviderError("InternalServerException", "NO_MESSAGE_ID", 200, false, "SendTextMessage answered without a message id");
      return { messageId: r.MessageId };
    },

    async account(region: string): Promise<SmsAccountInfo> {
      const [attrs, limits] = await Promise.all([
        call<{ AccountAttributes?: Array<{ Name: string; Value: string }> }>(region, "DescribeAccountAttributes", {}),
        call<{ SpendLimits?: Array<{ Name: string; EnforcedLimit: number; MaxLimit: number; Overridden: boolean }> }>(region, "DescribeSpendLimits", {}),
      ]);
      const tier = attrs.AccountAttributes?.find((a) => a.Name === "ACCOUNT_TIER")?.Value ?? "UNKNOWN";
      const text = limits.SpendLimits?.find((l) => l.Name === "TEXT_MESSAGE_MONTHLY_SPEND_LIMIT");
      return {
        tier,
        sandbox: tier.toUpperCase() !== "PRODUCTION",
        spendLimitUsd: text ? (text.Overridden ? text.EnforcedLimit : text.MaxLimit) : null,
        spendLimitMaxUsd: text?.MaxLimit ?? null,
      };
    },

    async identity(region: string, identity: string, country?: string | null): Promise<SmsIdentityInfo | null> {
      // arn:aws:sms-voice:<region>:<account>:phone-number/<id> | sender-id/<id>/<country> | pool/<id>
      const resource = identity.startsWith("arn:") ? identity.split(":").slice(5).join(":") : null;
      const [rType, rId, rCountry] = resource ? resource.split("/") : [null, identity, null];
      const id = rId ?? identity;
      const type = rType ?? (id.startsWith("phone-") || id.startsWith("+") ? "phone-number" : id.startsWith("pool-") ? "pool" : "sender-id");
      try {
        if (type === "phone-number") {
          const r = await call<{ PhoneNumbers?: Array<{ PhoneNumberArn: string; PhoneNumberId: string; PhoneNumber: string; Status?: string; IsoCountryCode?: string; NumberType?: string; TwoWayEnabled?: boolean; OptOutListName?: string; RegistrationId?: string }> }>(region, "DescribePhoneNumbers", { PhoneNumberIds: [id] });
          const p = r.PhoneNumbers?.[0];
          if (!p) return null;
          return {
            kind: NUMBER_KIND[p.NumberType ?? ""] ?? "long_code",
            arn: p.PhoneNumberArn,
            id: p.PhoneNumberId,
            // The business's own number, not a customer's: shown as it is.
            label: p.PhoneNumber,
            country: p.IsoCountryCode ?? null,
            status: p.Status ?? null,
            twoWay: !!p.TwoWayEnabled,
            optOutList: p.OptOutListName ?? null,
            registrationStatus: await registrationStatus(region, p.RegistrationId),
            tags: await tags(region, p.PhoneNumberArn),
          };
        }
        if (type === "pool") {
          const r = await call<{ Pools?: Array<{ PoolArn: string; PoolId: string; Status?: string; TwoWayEnabled?: boolean; OptOutListName?: string }> }>(region, "DescribePools", { PoolIds: [id] });
          const p = r.Pools?.[0];
          if (!p) return null;
          return { kind: "pool", arn: p.PoolArn, id: p.PoolId, label: p.PoolId, country: null, status: p.Status ?? null, twoWay: !!p.TwoWayEnabled, optOutList: p.OptOutListName ?? null, registrationStatus: null, tags: await tags(region, p.PoolArn) };
        }
        const iso = rCountry ?? country ?? null;
        if (!iso) return null;
        const r = await call<{ SenderIds?: Array<{ SenderIdArn: string; SenderId: string; IsoCountryCode: string; Registered?: boolean; RegistrationId?: string }> }>(region, "DescribeSenderIds", { SenderIds: [{ SenderId: id, IsoCountryCode: iso }] });
        const s = r.SenderIds?.[0];
        if (!s) return null;
        const registration = s.Registered ? "COMPLETE" : ((await registrationStatus(region, s.RegistrationId)) ?? (s.IsoCountryCode === "AU" ? "REQUIRED" : null));
        return {
          kind: "sender_id",
          arn: s.SenderIdArn,
          id: s.SenderId,
          label: s.SenderId,
          country: s.IsoCountryCode,
          status: s.Registered ? "REGISTERED" : "UNREGISTERED",
          twoWay: false,
          optOutList: null,
          registrationStatus: registration,
          tags: await tags(region, s.SenderIdArn),
        };
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },

    async taggedNumbers(region: string, country: string, key: string, value: string): Promise<SmsIdentityInfo[]> {
      // DescribePhoneNumbers can't filter by tag: the country's numbers, then each one's tags (an account has a handful).
      const out: SmsIdentityInfo[] = [];
      let next: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await call<{ PhoneNumbers?: Array<{ PhoneNumberArn: string; PhoneNumberId: string; PhoneNumber: string; Status?: string; IsoCountryCode?: string; NumberType?: string; TwoWayEnabled?: boolean; OptOutListName?: string; RegistrationId?: string }>; NextToken?: string }>(
          region,
          "DescribePhoneNumbers",
          { Filters: [{ Name: "iso-country-code", Values: [country] }], MaxResults: 20, ...(next ? { NextToken: next } : {}) },
        );
        for (const p of r.PhoneNumbers ?? []) {
          const t = await tags(region, p.PhoneNumberArn);
          if (t[key] !== value) continue;
          out.push({
            kind: NUMBER_KIND[p.NumberType ?? ""] ?? "long_code",
            arn: p.PhoneNumberArn,
            id: p.PhoneNumberId,
            label: p.PhoneNumber,
            country: p.IsoCountryCode ?? country,
            status: p.Status ?? null,
            twoWay: !!p.TwoWayEnabled,
            optOutList: p.OptOutListName ?? null,
            registrationStatus: await registrationStatus(region, p.RegistrationId),
            tags: t,
          });
        }
        next = r.NextToken;
        if (!next) break;
      }
      return out;
    },

    async optedOut(region: string, optOutList: string, since: Date | null): Promise<SmsOptedOutNumber[]> {
      const out: SmsOptedOutNumber[] = [];
      let next: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await call<{ OptedOutNumbers?: Array<{ OptedOutNumber: string; OptedOutTimestamp: number | string }>; NextToken?: string }>(region, "DescribeOptedOutNumbers", { OptOutListName: optOutList, MaxResults: 100, ...(next ? { NextToken: next } : {}) });
        for (const n of r.OptedOutNumbers ?? []) {
          const at = typeof n.OptedOutTimestamp === "number" ? new Date(n.OptedOutTimestamp * 1000) : new Date(n.OptedOutTimestamp);
          if (!since || at > since) out.push({ e164: n.OptedOutNumber, at });
        }
        next = r.NextToken;
        if (!next) break;
      }
      return out.sort((a, b) => b.at.getTime() - a.at.getTime());
    },

    async createVerifiedNumber(region: string, e164: string, tagMap: Record<string, string>) {
      const r = await call<{ VerifiedDestinationNumberId: string; Status: string }>(region, "CreateVerifiedDestinationNumber", { DestinationPhoneNumber: e164, Tags: Object.entries(tagMap).map(([Key, Value]) => ({ Key, Value })) });
      return { id: r.VerifiedDestinationNumberId, status: r.Status };
    },

    async sendVerificationCode(region: string, verifiedId: string, originationIdentity: string | null, configurationSet: string | null) {
      await call(region, "SendDestinationNumberVerificationCode", {
        VerifiedDestinationNumberId: verifiedId,
        VerificationChannel: "TEXT",
        ...(originationIdentity ? { OriginationIdentity: originationIdentity } : {}),
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
      });
    },

    async verifyNumber(region: string, verifiedId: string, code: string) {
      const r = await call<{ Status: string }>(region, "VerifyDestinationNumber", { VerifiedDestinationNumberId: verifiedId, VerificationCode: code });
      return { status: r.Status };
    },

    async deleteVerifiedNumber(region: string, verifiedId: string) {
      await call(region, "DeleteVerifiedDestinationNumber", { VerifiedDestinationNumberId: verifiedId }).catch((err: unknown) => {
        if (!notFound(err)) throw err;
      });
    },
  };
}
