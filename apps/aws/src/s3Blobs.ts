import { AwsClient } from "aws4fetch";
import type { BlobStore, FetchLike } from "@app/core";
import type { AwsCredentials } from "./awsClient.js";

/**
 * Webhook bodies too large for a queue message: a private S3 bucket whose
 * lifecycle rule deletes leftovers after 7 days; processed ones are deleted right away. Reached
 * through the VPC's S3 gateway endpoint, so this traffic never crosses the NAT gateway.
 */
export interface S3BlobOptions {
  bucket: string;
  region: string;
  credentials: AwsCredentials;
  fetchImpl?: FetchLike;
}

export function s3Blobs(o: S3BlobOptions): BlobStore {
  const signer = new AwsClient({ ...o.credentials, service: "s3", region: o.region });
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = (key: string) => `https://${o.bucket}.s3.${o.region}.amazonaws.com/${key.split("/").map(encodeURIComponent).join("/")}`;
  const send = async (method: string, key: string, body?: string) => {
    const signed = await signer.sign(url(key), { method, body, headers: body !== undefined ? { "content-type": "application/json" } : {} });
    return fetchImpl(signed.url, { method, headers: signed.headers, body: body !== undefined ? await signed.text() : undefined });
  };
  return {
    async put(key, value) {
      const res = await send("PUT", key, value);
      if (!res.ok) throw new Error(`S3 put ${key} failed (${res.status})`);
    },
    async get(key) {
      const res = await send("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S3 get ${key} failed (${res.status})`);
      return res.text();
    },
    async delete(key) {
      const res = await send("DELETE", key);
      if (!res.ok && res.status !== 404) throw new Error(`S3 delete ${key} failed (${res.status})`);
    },
  };
}
