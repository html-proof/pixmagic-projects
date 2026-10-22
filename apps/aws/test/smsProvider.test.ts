import { describe, expect, it } from "vitest";
import type { FetchLike } from "@app/core";
import { SmsProviderError } from "@app/core/sms";
import { awsSmsProvider } from "../src/smsProvider.js";

const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "token" };

interface Call {
  url: string;
  target: string;
  body: Record<string, unknown>;
  auth: string;
}

/** An AWS End User Messaging SMS endpoint that answers per operation, recording each call. */
function fakeAws(answers: Record<string, (body: Record<string, unknown>) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const headers = new Headers(init?.headers);
    const target = headers.get("x-amz-target") ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), target, body, auth: headers.get("authorization") ?? "" });
    const op = target.split(".").pop()!;
    const answer = answers[op];
    if (!answer) throw new Error(`unexpected ${op}`);
    return answer(body);
  }) as FetchLike;
  return { calls, provider: awsSmsProvider({ credentials: creds, fetchImpl }) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/x-amz-json-1.0", ...headers } });

describe("awsSmsProvider", () => {
  it("sends with SendTextMessage, signed for sms-voice in the sender's region, with the context and limits", async () => {
    const aws = fakeAws({ SendTextMessage: () => json({ MessageId: "mid-1" }) });
    const r = await aws.provider.send({
      region: "ap-south-1",
      destination: "+919876543210",
      body: "Hi",
      originationIdentity: "SENDER",
      messageType: "TRANSACTIONAL",
      configurationSet: "insights-production-sms",
      maxPrice: "0.25000",
      ttlSeconds: 86400,
      context: { job: "j1", ws: "w1" },
      dlt: { entityId: "110", templateId: "1107" },
    });
    expect(r).toEqual({ messageId: "mid-1" });
    const [call] = aws.calls;
    expect(call!.url).toBe("https://sms-voice.ap-south-1.amazonaws.com/");
    expect(call!.target).toBe("PinpointSMSVoiceV2.SendTextMessage");
    expect(call!.auth).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/ap-south-1\/sms-voice\/aws4_request/);
    expect(call!.body).toEqual({
      DestinationPhoneNumber: "+919876543210",
      OriginationIdentity: "SENDER",
      MessageBody: "Hi",
      MessageType: "TRANSACTIONAL",
      Context: { job: "j1", ws: "w1" },
      ConfigurationSetName: "insights-production-sms",
      MaxPrice: "0.25000",
      TimeToLive: 86400,
      DestinationCountryParameters: { IN_ENTITY_ID: "110", IN_TEMPLATE_ID: "1107" },
    });
  });

  it("keeps AWS's exception name and Reason, so the caller can tell an opt-out from a spend limit", async () => {
    const aws = fakeAws({
      SendTextMessage: (b) =>
        b.DestinationPhoneNumber === "+61400000001"
          ? json({ __type: "com.amazonaws.pinpointsmsvoicev2#ConflictException", message: "opted out", Reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT" }, 400)
          : json({ message: "limit", Reason: "MONTHLY_SPEND_LIMIT_REACHED_FOR_TEXT" }, 400, { "x-amzn-errortype": "ServiceQuotaExceededException:http://internal" }),
    });
    const send = (destination: string) => aws.provider.send({ region: "ap-southeast-2", destination, body: "x", originationIdentity: "S", messageType: "PROMOTIONAL", context: {} });
    await expect(send("+61400000001")).rejects.toMatchObject({ type: "ConflictException", reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT", status: 400, notSent: false });
    await expect(send("+61400000002")).rejects.toMatchObject({ type: "ServiceQuotaExceededException", reason: "MONTHLY_SPEND_LIMIT_REACHED_FOR_TEXT" });
  });

  it("tells a request that never left (DNS, refused) from one cut off after it may have arrived", async () => {
    const fail = (err: unknown) => awsSmsProvider({ credentials: creds, fetchImpl: (async () => Promise.reject(err)) as FetchLike });
    const req = { region: "ap-southeast-2", destination: "+61400000001", body: "x", originationIdentity: "S", messageType: "TRANSACTIONAL" as const, context: {} };
    const dns = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    await expect(fail(dns).send(req)).rejects.toMatchObject({ type: "network", notSent: true });
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    await expect(fail(reset).send(req)).rejects.toMatchObject({ type: "network", notSent: false });
    await expect(fail(new DOMException("timed out", "TimeoutError")).send(req)).rejects.toMatchObject({ type: "timeout", notSent: false });
    // A 200 without a message id is a broken answer: AWS may have the text.
    const empty = fakeAws({ SendTextMessage: () => json({}) });
    await expect(empty.provider.send(req)).rejects.toBeInstanceOf(SmsProviderError);
  });

  it("reads the account's tier and spending limit", async () => {
    const aws = fakeAws({
      DescribeAccountAttributes: () => json({ AccountAttributes: [{ Name: "ACCOUNT_TIER", Value: "SANDBOXED" }] }),
      DescribeSpendLimits: () => json({ SpendLimits: [{ Name: "TEXT_MESSAGE_MONTHLY_SPEND_LIMIT", EnforcedLimit: 1, MaxLimit: 1, Overridden: false }] }),
    });
    expect(await aws.provider.account("ap-southeast-2")).toEqual({ tier: "SANDBOXED", sandbox: true, spendLimitUsd: 1, spendLimitMaxUsd: 1 });
  });

  it("finds a sender ID with its registration and tags, and says nothing for one AWS doesn't have", async () => {
    const aws = fakeAws({
      DescribeSenderIds: (b) =>
        (b.SenderIds as Array<{ SenderId: string }>)[0]!.SenderId === "GREENLEAF"
          ? json({ SenderIds: [{ SenderIdArn: "arn:aws:sms-voice:ap-southeast-2:1:sender-id/GREENLEAF/AU", SenderId: "GREENLEAF", IsoCountryCode: "AU", Registered: false, RegistrationId: "reg-1" }] })
          : json({ __type: "ResourceNotFoundException", message: "nope" }, 400),
      DescribeRegistrations: () => json({ Registrations: [{ RegistrationStatus: "REVIEWING" }] }),
      ListTagsForResource: () => json({ Tags: [{ Key: "bizinsights:workspace", Value: "ws1" }] }),
    });
    expect(await aws.provider.identity("ap-southeast-2", "GREENLEAF", "AU")).toMatchObject({ kind: "sender_id", id: "GREENLEAF", country: "AU", status: "UNREGISTERED", registrationStatus: "REVIEWING", tags: { "bizinsights:workspace": "ws1" } });
    expect(await aws.provider.identity("ap-southeast-2", "MISSING", "AU")).toBeNull();
    // By ARN, the country comes from the ARN.
    expect(await aws.provider.identity("ap-southeast-2", "arn:aws:sms-voice:ap-southeast-2:1:sender-id/GREENLEAF/AU")).toMatchObject({ id: "GREENLEAF" });
  });

  it("pages through an opt-out list, newest first, from a given time", async () => {
    const aws = fakeAws({
      DescribeOptedOutNumbers: (b) =>
        b.NextToken
          ? json({ OptedOutNumbers: [{ OptedOutNumber: "+61400000003", OptedOutTimestamp: 1_760_000_300 }] })
          : json({ OptedOutNumbers: [{ OptedOutNumber: "+61400000001", OptedOutTimestamp: 1_760_000_100 }, { OptedOutNumber: "+61400000002", OptedOutTimestamp: 1_760_000_200 }], NextToken: "n" }),
    });
    const out = await aws.provider.optedOut("ap-southeast-2", "Default", new Date(1_760_000_150_000));
    expect(out.map((o) => o.e164)).toEqual(["+61400000003", "+61400000002"]);
  });
});
