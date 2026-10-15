import { AwsClient } from "aws4fetch";
import type { Coord, FetchLike } from "@app/core";

/**
 * The coordinator (rate-limit counters, one-time OAuth state, signed-out sessions, locks) on a
 * DynamoDB table, for AWS hosting: on Cloudflare a Durable Object does this job. Lambda runs many
 * instances at once, so this state has to live outside them. One item per key:
 *   k (string key), v (value), n (counter), until (ms epoch: when it stops counting),
 *   exp (seconds epoch: DynamoDB's TTL attribute, which deletes it some time after).
 * TTL deletion is lazy (up to a few days), so every read checks `until` itself.
 * Signed with the Lambda role's credentials (aws4fetch: the AWS SDK costs too much to load).
 */
export interface DynamoCoordOptions {
  table: string;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  fetchImpl?: FetchLike;
  now?: () => number;
}

type Item = Record<string, { S?: string; N?: string }>;

export class DynamoError extends Error {
  constructor(
    public type: string,
    message: string,
  ) {
    super(message);
    this.name = "DynamoError";
  }
}

export function dynamoCoord(o: DynamoCoordOptions): Coord {
  const signer = new AwsClient({ ...o.credentials, service: "dynamodb", region: o.region });
  const endpoint = `https://dynamodb.${o.region}.amazonaws.com/`;
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;

  async function call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    const signed = await signer.sign(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${op}` },
      body: JSON.stringify({ TableName: o.table, ...body }),
    });
    const res = await fetchImpl(signed.url, { method: "POST", headers: signed.headers, body: await signed.text() });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const type = String(json.__type ?? "").split("#").pop() || `Http${res.status}`;
      throw new DynamoError(type, `DynamoDB ${op} failed (${res.status} ${type}): ${String(json.message ?? json.Message ?? "")}`);
    }
    return json as T;
  }

  const item = (key: string, value: string, untilMs: number): Item => ({
    k: { S: key },
    v: { S: value },
    until: { N: String(untilMs) },
    exp: { N: String(Math.ceil(untilMs / 1000)) },
  });
  const live = (it: Item | undefined) => (it && Number(it.until?.N ?? 0) > now() ? it : undefined);

  return {
    async hit(key, windowSec) {
      // Fixed windows: the window's start is part of the key, so a new window starts from zero.
      const start = Math.floor(now() / (windowSec * 1000)) * windowSec * 1000;
      const r = await call<{ Attributes?: Item }>("UpdateItem", {
        Key: { k: { S: `${key}#${start}` } },
        UpdateExpression: "ADD n :one SET #u = if_not_exists(#u, :until), #e = if_not_exists(#e, :exp)",
        ExpressionAttributeNames: { "#u": "until", "#e": "exp" },
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":until": { N: String(start + windowSec * 1000) },
          ":exp": { N: String(Math.ceil((start + windowSec * 1000) / 1000)) },
        },
        ReturnValues: "UPDATED_NEW",
      });
      return Number(r.Attributes?.n?.N ?? 1);
    },
    async put(key, value, ttlSec) {
      await call("PutItem", { Item: item(key, value, now() + ttlSec * 1000) });
    },
    async take(key) {
      const r = await call<{ Attributes?: Item }>("DeleteItem", { Key: { k: { S: key } }, ReturnValues: "ALL_OLD" });
      return live(r.Attributes)?.v?.S ?? null;
    },
    async peek(key) {
      const r = await call<{ Item?: Item }>("GetItem", { Key: { k: { S: key } }, ConsistentRead: true });
      return live(r.Item)?.v?.S ?? null;
    },
    async acquire(key, ttlMs) {
      try {
        await call("PutItem", {
          Item: item(key, "1", now() + ttlMs),
          // Free, or held by someone whose lock has run out.
          ConditionExpression: "attribute_not_exists(k) OR #u < :now",
          ExpressionAttributeNames: { "#u": "until" },
          ExpressionAttributeValues: { ":now": { N: String(now()) } },
        });
        return true;
      } catch (err) {
        if (err instanceof DynamoError && err.type === "ConditionalCheckFailedException") return false;
        throw err;
      }
    },
    async release(key) {
      await call("DeleteItem", { Key: { k: { S: key } } });
    },
    async ping() {
      await call("GetItem", { Key: { k: { S: "ping" } } });
      return true;
    },
  };
}
