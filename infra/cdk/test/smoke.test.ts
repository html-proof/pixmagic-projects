import { describe, expect, it } from "vitest";

/**
 * The smoke tests' configuration check (configCheck in smoke.mjs): what the cron function answered
 * to {"action":"config"} becomes the PASS line, a ::warning:: per provider missing its secret, and a
 * failure only when the function itself threw. No answer is a warning: it says nothing about the
 * release, and a failed smoke test rolls every function back.
 */
interface Answer {
  meta: { FunctionError?: string; StatusCode?: number };
  report: unknown;
}
const { configCheck } = (await import(new URL("../scripts/smoke.mjs", import.meta.url).href)) as {
  configCheck: (invoke: () => Answer, envName: string) => { detail: string; warnings: string[] };
};

const credential = (provider: string, idSetting: string, secretSetting: string, idSet: boolean, secretSet: boolean, effect: string) => ({
  provider,
  idSetting,
  secretSetting,
  idSet,
  secretSet,
  effect,
});

/** What the shipped settings answer today, without META_APP_SECRET (core configReport.ts's shape). */
const REPORT = {
  ads: { configured: { meta: false, google: false, adsense: false }, restricted: { meta: false, google: false, adsense: false } },
  whatsapp: { embeddedSignup: false, embeddedSignupNeeds: ["WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET"], webhookVerifyToken: false },
  email: { google: false, microsoft: false, resend: true },
  auth: { cognito: true, google: false, emailOtp: false, loginCode: true },
  credentials: [
    credential("Shopify", "SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", true, true, "stores can't install the Shopify app or refresh their access"),
    credential("Meta Ads", "META_APP_ID", "META_APP_SECRET", true, false, 'Meta Ads says "Coming soon" and its connections stop syncing'),
    credential("WhatsApp (Embedded Signup)", "WHATSAPP_CONFIG_ID", "WHATSAPP_APP_SECRET", false, false, "Connect WhatsApp Business (Embedded Signup) can't be turned on"),
    credential("Outlook (email sending)", "EMAIL_MICROSOFT_CLIENT_ID", "EMAIL_MICROSOFT_CLIENT_SECRET", false, true, "Connect Outlook says it isn't set up"),
  ],
  halfConfigured: ["Meta Ads"],
};

/** An invoke that gives these answers in turn (an Error is thrown: the CLI got nothing back), and counts the calls. */
function answers(...seq: Array<Answer | Error>) {
  let calls = 0;
  const invoke = () => {
    const next = seq[Math.min(calls++, seq.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return { invoke, calls: () => calls };
}
const ok = (report: unknown = REPORT): Answer => ({ meta: { StatusCode: 200 }, report });
const threw = (message = "Reading secret insights/production/app failed (400 ResourceNotFoundException)"): Answer => ({
  meta: { StatusCode: 200, FunctionError: "Unhandled" },
  report: { errorType: "Error", errorMessage: message },
});
const cliError = (stderr: string) => Object.assign(new Error("Command failed: aws lambda invoke"), { stderr });

describe("the configuration check", () => {
  it("warns once per provider whose secret is missing, naming this environment in the command", () => {
    const { detail, warnings } = configCheck(answers(ok()).invoke, "production");
    expect(warnings).toEqual([
      `::warning title=Meta Ads isn't set up::META_APP_ID is set but META_APP_SECRET is missing from insights/production/app, so Meta Ads says "Coming soon" and its connections stop syncing. ` +
        "Copy the secret, run node infra/cdk/scripts/put-secrets.mjs --env production --set META_APP_SECRET, then run Deploy to AWS (Actions, Run workflow, on main) so the functions read it (docs/aws-deployment.md).",
    ]);
    expect(detail).toBe(
      "ads none (restricted none); WhatsApp Embedded Signup off (needs WHATSAPP_CONFIG_ID, WHATSAPP_APP_SECRET); email resend; Google sign-in off; emailed sign-in code on; missing a secret: Meta Ads",
    );
  });

  it("sends another environment's owner to that environment's secret and deploy, never production's", () => {
    const { warnings } = configCheck(answers(ok()).invoke, "staging");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing from insights/staging/app");
    expect(warnings[0]).toContain("put-secrets.mjs --env staging --set META_APP_SECRET");
    expect(warnings[0]).toContain("deploy staging again (cdk deploy --all -c env=staging)");
    expect(warnings[0]).not.toMatch(/production|Deploy to AWS/);
  });

  it("says nothing when every provider with an id has its secret", () => {
    const report = { ...REPORT, credentials: REPORT.credentials.map((c) => ({ ...c, secretSet: c.idSet || c.secretSet })) };
    const { detail, warnings } = configCheck(answers(ok(report)).invoke, "production");
    expect(warnings).toEqual([]);
    expect(detail).toMatch(/every provider with an id has its secret$/);
  });

  it("escapes what GitHub would read as the annotation's own syntax", () => {
    const report = { ...REPORT, credentials: [credential("Shop: one, two", "A_ID", "A_SECRET", true, false, "100% broken\nfor now")] };
    const [line] = configCheck(answers(ok(report)).invoke, "production").warnings;
    expect(line).toMatch(/^::warning title=Shop%3A one%2C two isn't set up::A_ID is set/);
    expect(line).toContain("so 100%25 broken%0Afor now.");
    expect(line).not.toContain("\n");
  });

  it("passes with a warning when the function can't be reached, after asking twice", () => {
    const a = answers(cliError("\nAn error occurred (TooManyRequestsException) when calling the Invoke operation: Rate Exceeded.\n"));
    const { detail, warnings } = configCheck(a.invoke, "production");
    expect(a.calls()).toBe(2);
    expect(detail).toBe("not checked: no answer from insights-production-cron: An error occurred (TooManyRequestsException) when calling the Invoke operation: Rate Exceeded.");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^::warning title=Provider secrets weren't checked::/);
    expect(warnings[0]).toContain('docs/aws-deployment.md, "Which provider secrets are there"');
  });

  it("uses the second answer when the first call got none", () => {
    const a = answers(cliError("Read timeout on endpoint URL"), ok());
    const { warnings } = configCheck(a.invoke, "production");
    expect(a.calls()).toBe(2);
    expect(warnings[0]).toMatch(/^::warning title=Meta Ads isn't set up::/);
  });

  it("fails when the function itself throws, twice", () => {
    const a = answers(threw());
    expect(() => configCheck(a.invoke, "production")).toThrow("Unhandled: Error Reading secret insights/production/app failed (400 ResourceNotFoundException)");
    expect(a.calls()).toBe(2);
  });

  it("passes when a cold start failed once and the second call answers", () => {
    const a = answers(threw(), ok());
    expect(configCheck(a.invoke, "production").detail).toMatch(/missing a secret: Meta Ads$/);
  });

  it("keeps an error the function gave over a second call that got nothing", () => {
    const a = answers(threw("boom"), cliError("Could not connect to the endpoint URL"));
    expect(() => configCheck(a.invoke, "production")).toThrow("Unhandled: Error boom");
  });

  it("passes with a warning on an answer it doesn't know (a function not on this commit)", () => {
    for (const report of [null, { statusCode: 404, body: "{}" }, { ...REPORT, credentials: [{ provider: "x" }] }, { ...REPORT, whatsapp: undefined }]) {
      const a = answers(ok(report));
      const { detail, warnings } = configCheck(a.invoke, "production");
      expect(a.calls(), JSON.stringify(report)).toBe(1);
      expect(detail, JSON.stringify(report)).toMatch(/^not checked: an answer this check doesn't know/);
      expect(warnings[0]).toMatch(/^::warning title=Provider secrets weren't checked::/);
    }
  });
});
