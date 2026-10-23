import { randomBytes } from "node:crypto";
import { buildClient, CommitmentPolicy, RawAesKeyringNode, RawAesWrappingSuiteIdentifier } from "@aws-crypto/client-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailError, type Mailer } from "@app/core";
import { decryptCode, sendCognitoEmail, unescapeTemporaryPassword, type CognitoEmailEvent } from "../src/cognitoEmail.js";

const POOL = "ap-southeast-2_TESTPOOL";

/** A keyring with a key of our own, standing in for the pool's KMS key: same SDK, same message format. */
function keyring() {
  return new RawAesKeyringNode({ keyName: "test-key", keyNamespace: "test", unencryptedMasterKey: new Uint8Array(randomBytes(32)), wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING });
}
const { encrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
/** What Cognito puts in `request.code`: the AWS Encryption SDK's message, base64, naming the pool. */
async function cognitoCiphertext(plaintext: string, ring: ReturnType<typeof keyring>, pool = POOL) {
  const { result } = await encrypt(ring, plaintext, { encryptionContext: { "userpool-id": pool } });
  return Buffer.from(result).toString("base64");
}

function event(triggerSource: string, overrides: Partial<CognitoEmailEvent["request"]> = {}): CognitoEmailEvent {
  return {
    version: "1",
    triggerSource,
    region: "ap-southeast-2",
    userPoolId: POOL,
    userName: "0b5e0f4e-0000-4000-8000-000000000000",
    request: { type: "customEmailSenderRequestV1", code: "Y2lwaGVydGV4dA==", clientMetadata: {}, userAttributes: { email: "merchant@example.test", name: "Alex", email_verified: "false" }, ...overrides },
  };
}

function recordingMailer(fail?: Error) {
  const sent: Array<{ to: string; subject: string; text: string; html?: string; idempotencyKey?: string; purpose?: string }> = [];
  const mailer: Mailer = {
    async send(to, subject, text, html, opts) {
      if (fail) throw fail;
      sent.push({ to, subject, text, html, idempotencyKey: opts?.idempotencyKey, purpose: opts?.purpose });
      return { provider: "resend", messageId: `re_${sent.length}` };
    },
  };
  return { mailer, sent };
}

afterEach(() => vi.restoreAllMocks());

describe("decrypting Cognito's codes", () => {
  it("reads the code Cognito encrypted with the AWS Encryption SDK", async () => {
    const ring = keyring();
    expect(await decryptCode(await cognitoCiphertext("482913", ring), ring, POOL)).toBe("482913");
  });

  it("refuses a code encrypted for another user pool", async () => {
    const ring = keyring();
    await expect(decryptCode(await cognitoCiphertext("482913", ring, "ap-southeast-2_OTHER"), ring, POOL)).rejects.toThrow(/another user pool/);
  });

  it("can't read a code under a key it doesn't hold", async () => {
    await expect(decryptCode(await cognitoCiphertext("482913", keyring()), keyring(), POOL)).rejects.toThrow();
  });

  it("restores the characters Cognito HTML-escapes in temporary passwords", () => {
    expect(unescapeTemporaryPassword("a&lt;b&gt;c&amp;d&quot;e&#39;f")).toBe(`a<b>c&d"e'f`);
    expect(unescapeTemporaryPassword("&amp;lt;")).toBe("&lt;");
  });
});

describe("the custom email sender", () => {
  const appUrl = "https://bizinsights.io";

  it("sends each trigger's email to the user's address, with the decrypted code", async () => {
    const ring = keyring();
    for (const [trigger, subject] of [
      ["CustomEmailSender_SignUp", "Your bizinsights verification code"],
      ["CustomEmailSender_ResendCode", "Your bizinsights verification code"],
      ["CustomEmailSender_ForgotPassword", "Reset your bizinsights password"],
      ["CustomEmailSender_UpdateUserAttribute", "Confirm your new bizinsights email address"],
      ["CustomEmailSender_VerifyUserAttribute", "Your bizinsights verification code"],
      ["CustomEmailSender_Authentication", "Your bizinsights verification code"],
      ["CustomEmailSender_AdminCreateUser", "Your bizinsights account is ready"],
    ] as const) {
      const { mailer, sent } = recordingMailer();
      const code = await cognitoCiphertext("482913", ring);
      const result = await sendCognitoEmail(event(trigger, { code }), { decrypt: (c, pool) => decryptCode(c, ring, pool), mailer, appUrl });
      expect(result, trigger).toEqual({ sent: true, provider: "resend", messageId: "re_1" });
      expect(sent, trigger).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: "merchant@example.test", subject });
      expect(sent[0]!.text).toContain("482913");
      expect(sent[0]!.html).toContain("482913");
      expect(sent[0]!.subject).not.toContain("482913");
    }
  });

  it("asks for the support sender (a code's purpose, never an address) and signs off as it", async () => {
    const senders = {
      EMAIL_FROM: "bizinsights <no-reply@bizinsights.io>",
      OTP_FROM_EMAIL: "support@bizinsights.io",
      OTP_FROM_NAME: "BizInsights Support",
      LINK_FROM_EMAIL: "link@bizinsights.io",
      LINK_FROM_NAME: "BizInsights",
      SUPPORT_EMAIL: "support@bizinsights.io",
    };
    const { mailer, sent } = recordingMailer();
    const deps = { decrypt: async () => "482913", mailer, appUrl, senders };
    await sendCognitoEmail(event("CustomEmailSender_SignUp"), deps);
    await sendCognitoEmail(event("CustomEmailSender_ForgotPassword"), deps);
    await sendCognitoEmail(event("CustomEmailSender_VerifyUserAttribute"), deps);
    expect(sent.map((m) => m.purpose)).toEqual(["signup_code", "password_reset_code", "verification_code"]);
    for (const m of sent) expect(m.text).toContain("BizInsights Support");
  });

  it("sends a temporary password as typed, with the sign-in link", async () => {
    const { mailer, sent } = recordingMailer();
    await sendCognitoEmail(event("CustomEmailSender_AdminCreateUser"), { decrypt: async () => "Tmp&lt;9&amp;x", mailer, appUrl });
    expect(sent[0]!.text).toContain("Temporary password: Tmp<9&x");
    expect(sent[0]!.text).toContain("https://bizinsights.io/login");
    // Escaped once for HTML, so the reader sees the same characters.
    expect(sent[0]!.html).toContain("Tmp&lt;9&amp;x");
  });

  it("asks the provider to send a retried invocation only once", async () => {
    const { mailer, sent } = recordingMailer();
    const deps = { decrypt: async () => "482913", mailer, appUrl };
    await sendCognitoEmail(event("CustomEmailSender_SignUp", { code: "QUJD" }), deps);
    await sendCognitoEmail(event("CustomEmailSender_SignUp", { code: "QUJD" }), deps);
    await sendCognitoEmail(event("CustomEmailSender_SignUp", { code: "REVG" }), deps);
    expect(sent[0]!.idempotencyKey).toMatch(/^cognito-[0-9a-f]{48}$/);
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(sent[2]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  });

  it("sends nothing, and doesn't fail, when there is nothing to send", async () => {
    const { mailer, sent } = recordingMailer();
    const decrypt = vi.fn(async () => "482913");
    const deps = { decrypt, mailer, appUrl };
    expect(await sendCognitoEmail(event("CustomEmailSender_AccountTakeOverNotification"), deps)).toEqual({ sent: false, reason: "no_message" });
    expect(await sendCognitoEmail(event("CustomEmailSender_SignUp", { userAttributes: { name: "Alex" } }), deps)).toEqual({ sent: false, reason: "no_address" });
    expect(await sendCognitoEmail(event("CustomEmailSender_SignUp", { code: null }), deps)).toEqual({ sent: false, reason: "no_code" });
    expect(sent).toHaveLength(0);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("fails when the provider does (Lambda retries it), and logs neither the code nor the address", async () => {
    const lines: string[] = [];
    for (const method of ["log", "info", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const level = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const { mailer } = recordingMailer(new MailError("Resend send failed (429 rate_limit_exceeded): slow down", "resend", "transient", "rate_limit_exceeded"));
      await expect(sendCognitoEmail(event("CustomEmailSender_ForgotPassword"), { decrypt: async () => "482913", mailer, appUrl })).rejects.toThrow(/rate_limit_exceeded/);
      const ok = recordingMailer();
      await sendCognitoEmail(event("CustomEmailSender_SignUp"), { decrypt: async () => "482913", mailer: ok.mailer, appUrl });
      await sendCognitoEmail(event("CustomEmailSender_SignUp", { userAttributes: {} }), { decrypt: async () => "482913", mailer: ok.mailer, appUrl });
    } finally {
      if (level === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = level;
    }
    expect(lines.join("\n")).toContain("cognito email sent");
    expect(lines.join("\n")).toContain("nothing sent");
    expect(lines.join("\n")).not.toMatch(/482913|merchant@example\.test/);
  });
});
