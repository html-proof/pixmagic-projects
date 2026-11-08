import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";
import { describe, expect, it } from "vitest";

/**
 * The upload links the way back makes (infra/ikorex/scripts/copy-db-lib.mjs presignS3, used by
 * copy-db-back.mjs: the server's dumps go straight into the bucket) signed the way aws4fetch, the
 * signer the functions already use, signs the same request. copy-db-lib.test.mjs checks AWS's own
 * documented example; this checks PUT with a session's token, which that example doesn't cover.
 */
type Presign = (o: { method: string; bucket: string; key: string; region: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }; now?: Date; expires?: number }) => string;
const lib = (): Promise<{ presignS3: Presign }> => import(pathToFileURL(resolve(__dirname, "../../../infra/ikorex/scripts/copy-db-lib.mjs")).href);

describe("presigned upload links (copy-db-back.mjs)", () => {
  it("match aws4fetch's signature for the same PUT, the session's token included", async () => {
    const { presignS3 } = await lib();
    const credentials = { accessKeyId: "ASIAEXAMPLEEXAMPLE12", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sessionToken: "IQoJb3JpZ2luX2VjEJr//////////wEaDmFwLXNvdXRoZWFzdC0yIkcwRQ+tok=" };
    const bucket = "insights-production-artifacts-123456789012";
    const key = "db-export/20261108T093000Z-back/app.dump";
    const now = new Date("2026-11-08T09:30:00Z");
    const ours = new URL(presignS3({ method: "PUT", bucket, key, region: "ap-southeast-2", credentials, now, expires: 3600 }));

    const signer = new AwsClient({ ...credentials, service: "s3", region: "ap-southeast-2" });
    const theirs = new URL((await signer.sign(`https://${bucket}.s3.ap-southeast-2.amazonaws.com/${key}?X-Amz-Expires=3600`, { method: "PUT", aws: { signQuery: true, datetime: "20261108T093000Z" } })).url);

    expect(ours.host).toBe(theirs.host);
    expect(ours.pathname).toBe(theirs.pathname);
    for (const p of ["X-Amz-Credential", "X-Amz-Date", "X-Amz-Expires", "X-Amz-SignedHeaders", "X-Amz-Security-Token"]) expect(ours.searchParams.get(p), p).toBe(theirs.searchParams.get(p));
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(theirs.searchParams.get("X-Amz-Signature"));
  });
});
