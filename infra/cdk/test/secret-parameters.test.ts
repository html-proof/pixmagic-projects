import { describe, expect, it } from "vitest";
import { SECRET_PARAMETERS_CODE, SECRET_PARAMETERS_FAILED } from "../lib/secret-parameters.js";

/**
 * The copier's handler, exactly as CloudFormation runs it (the inline string), against stand-in
 * Secrets Manager and Parameter Store: what it writes, what it leaves alone, and that no value
 * ever reaches a log line, an answer or an error.
 */

type Secret = { text: string; created: Date } | { error: string };
type Parameter = { value: string; modified: Date } | { error: string };
type Answer = { PhysicalResourceId: string; Data?: { Copied: string } };

const VALUE = "s3cr3t-value-never-shown";
const OLD = new Date("2026-11-01T00:00:00Z");
const NEW = new Date("2026-11-12T00:00:00Z");

function load(world: { secrets?: Record<string, Secret>; parameters?: Record<string, Parameter>; putError?: string; stack?: string | { error: string } }) {
  const secrets = world.secrets ?? {};
  const parameters = { ...(world.parameters ?? {}) };
  const puts: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const named = (name: string, message = `stand-in ${name}`) => Object.assign(new Error(message), { name });
  const command = (kind: string) =>
    class {
      kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  const client = (send: (cmd: { kind: string; input: Record<string, string> }) => unknown) =>
    class {
      async send(cmd: { kind: string; input: Record<string, string> }) {
        return send(cmd);
      }
    };
  const modules: Record<string, unknown> = {
    "@aws-sdk/client-secrets-manager": {
      GetSecretValueCommand: command("GetSecretValue"),
      SecretsManagerClient: client(({ input }) => {
        const s = secrets[input.SecretId!];
        if (!s) throw named("ResourceNotFoundException");
        if ("error" in s) throw named(s.error);
        return { SecretString: s.text, CreatedDate: s.created };
      }),
    },
    "@aws-sdk/client-ssm": {
      GetParameterCommand: command("GetParameter"),
      PutParameterCommand: command("PutParameter"),
      SSMClient: client(({ kind, input }) => {
        if (kind === "PutParameter") {
          // As AWS words a refusal: it quotes the value.
          if (world.putError) throw named(world.putError, `Value '${input.Value}' at 'value' failed to satisfy constraint`);
          puts.push(input);
          parameters[input.Name!] = { value: input.Value!, modified: new Date() };
          return { Version: 1 };
        }
        const p = parameters[input.Name!];
        if (!p) throw named("ParameterNotFound");
        if ("error" in p) throw named(p.error);
        return { Parameter: { Name: input.Name, Value: p.value, LastModifiedDate: p.modified } };
      }),
    },
    "@aws-sdk/client-cloudformation": {
      DescribeStacksCommand: command("DescribeStacks"),
      CloudFormationClient: client(() => {
        const status = world.stack ?? "UPDATE_IN_PROGRESS";
        if (typeof status !== "string") throw named(status.error);
        return { Stacks: [{ StackStatus: status }] };
      }),
    },
  };
  const module = { exports: {} as { onEvent: (event: unknown) => Promise<Answer> } };
  new Function("require", "exports", "module", "console", SECRET_PARAMETERS_CODE)((name: string) => modules[name], module.exports, module, { log: (line: string) => logs.push(line) });
  return { onEvent: module.exports.onEvent, puts, logs, parameters };
}

const STACK = "arn:aws:cloudformation:ap-southeast-2:605411278365:stack/InsightsApp-production/0f1e2d3c";
const NAMES = ["insights/production/app", "insights/production/db-owner", "insights/production/origin-lock"];
const event = (type: "Create" | "Update" | "Delete", names = NAMES) => ({ RequestType: type, StackId: STACK, PhysicalResourceId: type === "Create" ? undefined : "secret-parameters", ResourceProperties: { Release: "abc1234", Secrets: names } });
const secret = (text: string, created = OLD): Secret => ({ text, created });

describe("the secrets' copies in Parameter Store (secret-parameters.ts)", () => {
  it("creates each parameter as a standard SecureString holding the secret's text exactly, JSON or plain", async () => {
    const json = JSON.stringify({ SESSION_SECRET: VALUE, port: 5432 });
    const { onEvent, puts } = load({ secrets: { "insights/production/app": secret(json), "insights/production/db-owner": secret(json), "insights/production/origin-lock": secret(VALUE) } });
    const answer = await onEvent(event("Create"));
    expect(puts).toEqual([
      { Name: "/insights/production/app", Value: json, Type: "SecureString", Tier: "Standard", Overwrite: true, Description: "Copy of the Secrets Manager secret insights/production/app" },
      { Name: "/insights/production/db-owner", Value: json, Type: "SecureString", Tier: "Standard", Overwrite: true, Description: "Copy of the Secrets Manager secret insights/production/db-owner" },
      { Name: "/insights/production/origin-lock", Value: VALUE, Type: "SecureString", Tier: "Standard", Overwrite: true, Description: "Copy of the Secrets Manager secret insights/production/origin-lock" },
    ]);
    expect(answer).toEqual({ PhysicalResourceId: "secret-parameters", Data: { Copied: "app: created, db-owner: created, origin-lock: created" } });
  });

  it("writes nothing when the copy already matches, on every later release", async () => {
    const { onEvent, puts } = load({
      secrets: { "insights/production/app": secret(VALUE) },
      parameters: { "/insights/production/app": { value: VALUE, modified: NEW } },
    });
    const answer = await onEvent(event("Update", ["insights/production/app"]));
    expect(puts).toEqual([]);
    expect(answer.Data).toEqual({ Copied: "app: same" });
  });

  it("copies a secret changed since (put-secrets, the console), and keeps a parameter written after the secret", async () => {
    const { onEvent, puts } = load({
      secrets: { "insights/production/app": secret("new text", NEW), "insights/production/db-owner": secret("old text", OLD) },
      parameters: { "/insights/production/app": { value: "old text", modified: OLD }, "/insights/production/db-owner": { value: "newer text", modified: NEW } },
    });
    const answer = await onEvent(event("Update", ["insights/production/app", "insights/production/db-owner"]));
    expect(puts.map((p) => [p.Name, p.Value])).toEqual([["/insights/production/app", "new text"]]);
    expect(answer.Data).toEqual({ Copied: "app: updated, db-owner: differs, parameter newer: kept" });
  });

  it("passes over a secret that doesn't exist (no origin lock; a new environment before its Auth stack)", async () => {
    const { onEvent, puts } = load({ secrets: { "insights/production/app": secret(VALUE) } });
    const answer = await onEvent(event("Create"));
    expect(puts).toHaveLength(1);
    expect(answer.Data).toEqual({ Copied: "app: created, db-owner: no secret, origin-lock: no secret" });
  });

  it("does nothing on Delete: the parameters stay", async () => {
    const { onEvent, puts, logs } = load({ secrets: { "insights/production/app": secret(VALUE) } });
    expect(await onEvent(event("Delete"))).toEqual({ PhysicalResourceId: "secret-parameters" });
    expect(puts).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("fails the release, by AWS's error name alone, while the stack is going forward, after trying every secret", async () => {
    const { onEvent, puts } = load({ secrets: { "insights/production/app": { error: "AccessDeniedException" }, "insights/production/db-owner": secret(VALUE) } });
    await expect(onEvent(event("Update", ["insights/production/app", "insights/production/db-owner"]))).rejects.toThrow(
      `${SECRET_PARAMETERS_FAILED} (nothing moved to the new release): app (reading the secret: AccessDeniedException)`,
    );
    expect(puts.map((p) => p.Name)).toEqual(["/insights/production/db-owner"]);
  });

  it("refuses a secret longer than a standard parameter holds, rather than paying for an advanced one", async () => {
    const { onEvent, puts } = load({ secrets: { "insights/production/app": secret("x".repeat(4097)) } });
    await expect(onEvent(event("Update", ["insights/production/app"]))).rejects.toThrow("app (longer than a standard parameter's 4096 characters)");
    expect(puts).toEqual([]);
  });

  it("never fails a rollback: the failure is reported and the stack goes on rolling back", async () => {
    for (const stack of ["UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS", { error: "Throttling" }]) {
      const { onEvent } = load({ secrets: { "insights/production/app": secret(VALUE) }, putError: "ThrottlingException", stack });
      const answer = await onEvent(event("Update", ["insights/production/app"]));
      expect(answer.Data).toEqual({ Copied: "app: FAILED writing the parameter: ThrottlingException" });
    }
  });

  it("never shows a value: not in a log line, an answer, or an error AWS worded with it", async () => {
    const world = { secrets: { "insights/production/app": secret(VALUE), "insights/production/db-owner": secret(JSON.stringify({ password: VALUE })) } };
    const ok = load(world);
    const answer = await ok.onEvent(event("Create"));
    expect(JSON.stringify(answer) + ok.logs.join("\n")).not.toContain(VALUE);
    expect(ok.logs).toEqual([JSON.stringify({ copied: ["app: created", "db-owner: created", "origin-lock: no secret"] })]);

    const refused = load({ ...world, putError: "ValidationException" });
    const error = await refused.onEvent(event("Create")).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message) + String((error as Error).stack) + refused.logs.join("\n")).not.toContain(VALUE);
    expect((error as Error).message).toContain("app (writing the parameter: ValidationException)");
  });

  it("fits its handler inline, with nothing an untagged template literal would mangle", () => {
    expect(SECRET_PARAMETERS_CODE.length).toBeLessThan(4096);
    for (const s of ["\\", "`", "${"]) expect(SECRET_PARAMETERS_CODE).not.toContain(s);
    expect(SECRET_PARAMETERS_CODE).toContain(SECRET_PARAMETERS_FAILED);
  });
});
