import { AwsClient } from "aws4fetch";
import type { FetchLike } from "@app/core";

/**
 * Signed calls to AWS's JSON APIs (SQS, SSM, Secrets Manager) with the Lambda role's temporary
 * credentials. aws4fetch instead of the AWS SDK: the SDK costs hundreds of milliseconds to load on
 * a cold start, and these are a handful of plain POSTs.
 */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The credentials Lambda puts in the function's environment (they last as long as the instance). */
export function roleCredentials(env: NodeJS.ProcessEnv = process.env): AwsCredentials {
  return { accessKeyId: env.AWS_ACCESS_KEY_ID ?? "", secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "", sessionToken: env.AWS_SESSION_TOKEN };
}

export class AwsApiError extends Error {
  constructor(
    public service: string,
    public type: string,
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AwsApiError";
  }
}

export interface JsonApiOptions {
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** "1.0" (SQS, DynamoDB) or "1.1" (SSM, Secrets Manager). */
  jsonVersion: "1.0" | "1.1";
  /** X-Amz-Target prefix, e.g. "AmazonSQS". */
  targetPrefix: string;
  fetchImpl?: FetchLike;
}

export function jsonApi(o: JsonApiOptions) {
  const signer = new AwsClient({ ...o.credentials, service: o.service, region: o.region });
  const endpoint = `https://${o.service}.${o.region}.amazonaws.com/`;
  const fetchImpl = o.fetchImpl ?? fetch;
  return async function call<T>(operation: string, body: Record<string, unknown>): Promise<T> {
    const signed = await signer.sign(endpoint, {
      method: "POST",
      headers: { "content-type": `application/x-amz-json-${o.jsonVersion}`, "x-amz-target": `${o.targetPrefix}.${operation}` },
      body: JSON.stringify(body),
    });
    const res = await fetchImpl(signed.url, { method: "POST", headers: signed.headers, body: await signed.text() });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as T & { __type?: string; message?: string; Message?: string };
    if (!res.ok) {
      const type = (json.__type ?? "").split("#").pop() ?? "";
      throw new AwsApiError(o.service, type, res.status, `${o.service} ${operation} failed (${res.status} ${type}): ${json.message ?? json.Message ?? ""}`);
    }
    return json;
  };
}
