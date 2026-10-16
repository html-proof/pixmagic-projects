import { AwsClient } from "aws4fetch";
import { env, type FetchLike, type Mailer } from "@app/core";
import type { AwsCredentials } from "./awsClient.js";

/**
 * App email (invitations, alerts, staff notices) through Amazon SES v2. EMAIL_FROM must be an
 * SES-verified address or domain in this region; while the account is in the SES sandbox,
 * recipients must be verified too (SES answers 400 otherwise, and the caller logs it).
 * Merchants' own connected accounts (Gmail, Microsoft 365, SMTP) don't come through here.
 */
export interface SesOptions {
  region: string;
  credentials: AwsCredentials;
  /** SES configuration set (bounce and complaint events). */
  configurationSet?: string;
  fetchImpl?: FetchLike;
}

export function sesMailer(o: SesOptions): Mailer {
  const signer = new AwsClient({ ...o.credentials, service: "ses", region: o.region });
  const endpoint = `https://email.${o.region}.amazonaws.com/v2/email/outbound-emails`;
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    async send(to, subject, text, html, opts) {
      const body = {
        FromEmailAddress: env().EMAIL_FROM,
        Destination: { ToAddresses: [to] },
        ...(opts?.replyTo ? { ReplyToAddresses: [opts.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" }, ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}) },
          },
        },
        ...(o.configurationSet ? { ConfigurationSetName: o.configurationSet } : {}),
      };
      const signed = await signer.sign(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await fetchImpl(signed.url, { method: "POST", headers: signed.headers, body: await signed.text() });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        // The recipient's address is not repeated here (logs); SES's own message names the problem.
        throw new Error(`SES send failed (${res.status}): ${err.message ?? "unknown error"}`);
      }
    },
  };
}
