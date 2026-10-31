import { describe, expect, it } from "vitest";
import { MIGRATE_BEFORE_LIVE_CODE, MIGRATE_BEFORE_LIVE_FAILED } from "../lib/migrate-before-live.js";

/**
 * The gate's handler, exactly as CloudFormation runs it (the inline string), against stand-in AWS
 * clients: which events invoke the cron's migrate, which skip it, and which fail the App stack
 * before any `live` alias moves.
 */

type Command = "DescribeStacksCommand" | "GetParameterCommand" | "InvokeCommand";
type Reply = { error: string } | Record<string, unknown>;
type Answer = { PhysicalResourceId: string; Data?: { Applied: string } };

function load(script: Partial<Record<Command, Reply[]>>) {
  const calls: Array<{ command: Command; input: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const clientOptions: unknown[] = [];
  const delays: number[] = [];
  const queue = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...(v ?? [])]])) as Partial<Record<Command, Reply[]>>;
  const sdk = (client: string, command: Command) => ({
    [client]: class {
      constructor(options: unknown) {
        clientOptions.push(options);
      }
      async send(cmd: { command: Command; input: Record<string, unknown> }) {
        calls.push({ command: cmd.command, input: cmd.input });
        const reply = queue[cmd.command]?.shift();
        if (!reply) throw new Error(`no reply scripted for ${cmd.command}`);
        if ("error" in reply) throw Object.assign(new Error(`stand-in ${reply.error}`), { name: reply.error });
        return reply;
      }
    },
    [command]: class {
      command = command;
      constructor(public input: Record<string, unknown>) {}
    },
  });
  const modules: Record<string, unknown> = {
    "@aws-sdk/client-lambda": sdk("LambdaClient", "InvokeCommand"),
    "@aws-sdk/client-cloudformation": sdk("CloudFormationClient", "DescribeStacksCommand"),
    "@aws-sdk/client-ssm": sdk("SSMClient", "GetParameterCommand"),
  };
  const module = { exports: {} as { onEvent: (event: unknown) => Promise<Answer> } };
  // setTimeout runs at once (a retry costs no time) and keeps the wait it was asked for.
  new Function("require", "exports", "module", "Buffer", "console", "setTimeout", MIGRATE_BEFORE_LIVE_CODE)(
    (name: string) => modules[name],
    module.exports,
    module,
    Buffer,
    { log: (line: string) => logs.push(line) },
    (f: () => void, ms: number) => {
      delays.push(ms);
      f();
    },
  );
  return { onEvent: module.exports.onEvent, calls, logs, clientOptions, delays };
}

const CRON = "arn:aws:lambda:ap-southeast-2:605411278365:function:insights-production-cron";
const STACK = "arn:aws:cloudformation:ap-southeast-2:605411278365:stack/InsightsApp-production/0f1e2d3c";
const PARAM = "/insights/production/runtime";
const props = (version: number) => ({ ServiceToken: "arn:aws:lambda:...:provider", Target: `${CRON}:${version}`, RuntimeParam: PARAM });
const update = (from: number, to: number) => ({ RequestType: "Update", StackId: STACK, PhysicalResourceId: "migrate-before-live", ResourceProperties: props(to), OldResourceProperties: props(from) });
const create = (version: number) => ({ RequestType: "Create", StackId: STACK, ResourceProperties: props(version) });
const stack = (status: string) => ({ Stacks: [{ StackStatus: status }] });
const found = { Parameter: { Name: PARAM, Type: "String" } };
const ran = (applied: string[], total: number) => ({ StatusCode: 200, ExecutedVersion: "142", Payload: Buffer.from(JSON.stringify({ applied, total })) });

describe("the gate on a CloudFormation rollback, or nothing newer", () => {
  it("answers the rollback's swapped properties without calling anything", async () => {
    const h = load({});
    const answer = await h.onEvent(update(142, 141));
    expect(h.calls).toEqual([]);
    expect(answer).toEqual({ PhysicalResourceId: "migrate-before-live", Data: { Applied: "version 141: skipped: rollback or nothing newer (142 to 141)" } });
  });

  it("calls nothing for the same version", async () => {
    const h = load({});
    expect((await h.onEvent(update(142, 142))).Data?.Applied).toMatch(/skipped: rollback/);
    expect(h.calls).toEqual([]);
  });

  it("goes on for a lower number of another function (a renamed environment's cron)", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [ran([], 63)] });
    const event = { ...update(142, 7), OldResourceProperties: { Target: `${CRON}-old:142`, RuntimeParam: PARAM } };
    await h.onEvent(event);
    expect(h.calls.map((c) => c.command)).toEqual(["DescribeStacksCommand", "GetParameterCommand", "InvokeCommand"]);
  });

  it("does nothing on Delete and keeps the id it was given", async () => {
    const h = load({});
    expect(await h.onEvent({ RequestType: "Delete", StackId: STACK, PhysicalResourceId: "migrate-before-live", ResourceProperties: props(142) })).toEqual({ PhysicalResourceId: "migrate-before-live" });
    expect(h.calls).toEqual([]);
  });
});

describe("the gate during a deploy", () => {
  it("runs the new version's migrate, with the constant payload, and says what it applied", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [ran(["20261031120000_x"], 63)] });
    const event = update(141, 142);
    (event.ResourceProperties as Record<string, unknown>).Payload = '{"action":"evolution-db"}';
    const answer = await h.onEvent(event);
    expect(h.calls).toEqual([
      { command: "DescribeStacksCommand", input: { StackName: STACK } },
      { command: "GetParameterCommand", input: { Name: PARAM } },
      { command: "InvokeCommand", input: { FunctionName: `${CRON}:142`, Payload: expect.anything() } },
    ]);
    expect(Buffer.from(h.calls[2]!.input.Payload as Uint8Array).toString("utf8")).toBe('{"action":"migrate"}');
    expect(answer).toEqual({ PhysicalResourceId: "migrate-before-live", Data: { Applied: "version 142: applied 20261031120000_x (63 in all)" } });
  });

  it("says none when nothing was pending", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [ran([], 63)] });
    expect((await h.onEvent(update(141, 142))).Data?.Applied).toBe("version 142: applied none (63 in all)");
  });

  it("runs on its own creation inside an existing stack (the first deploy with the gate)", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [ran([], 63)] });
    await h.onEvent(create(142));
    expect(h.calls.filter((c) => c.command === "InvokeCommand")).toHaveLength(1);
  });

  it.each(["CREATE_IN_PROGRESS", "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_COMPLETE"])("skips while the stack is %s", async (status) => {
    const h = load({ DescribeStacksCommand: [stack(status)] });
    expect((await h.onEvent(create(1))).Data?.Applied).toBe(`version 1: skipped: stack ${status}`);
    expect(h.calls.map((c) => c.command)).toEqual(["DescribeStacksCommand"]);
  });

  it("skips while there is no runtime parameter yet (App without Auth)", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [{ error: "ParameterNotFound" }] });
    expect((await h.onEvent(update(141, 142))).Data?.Applied).toBe(`version 142: skipped: no ${PARAM} yet`);
    expect(h.calls.map((c) => c.command)).not.toContain("InvokeCommand");
  });

  it("logs exactly one decision line per event; only the Lambda client is kept from retrying on its own", async () => {
    for (const [script, event] of [
      [{}, update(142, 141)],
      [{ DescribeStacksCommand: [stack("CREATE_IN_PROGRESS")] }, create(1)],
      [{ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [ran([], 1)] }, update(1, 2)],
      [{}, { RequestType: "Delete", PhysicalResourceId: "migrate-before-live", ResourceProperties: props(2) }],
    ] as const) {
      const h = load(script as Partial<Record<Command, Reply[]>>);
      await h.onEvent(event);
      expect(h.logs).toHaveLength(1);
      expect(JSON.parse(h.logs[0]!)).toHaveProperty("decision");
      // Lambda, CloudFormation, SSM: after a timeout the cron may have run, while the reads are safe to repeat.
      expect(h.clientOptions).toEqual([{ maxAttempts: 1 }, {}, {}]);
      expect(h.delays).toEqual([]);
    }
  });

  it("still succeeds when a successful migrate's answer isn't JSON", async () => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [{ StatusCode: 200, Payload: Buffer.from("null?") }] });
    expect((await h.onEvent(update(1, 2))).PhysicalResourceId).toBe("migrate-before-live");
  });
});

describe("the gate's retries and failures", () => {
  it("waits for IAM to take a fresh role: CloudFormation's AccessDenied, Lambda's and SSM's AccessDeniedException", async () => {
    const h = load({
      DescribeStacksCommand: [{ error: "AccessDenied" }, { error: "AccessDenied" }, stack("UPDATE_IN_PROGRESS")],
      GetParameterCommand: [{ error: "AccessDeniedException" }, found],
      InvokeCommand: [{ error: "AccessDeniedException" }, ran([], 1)],
    });
    await h.onEvent(update(1, 2));
    expect(h.calls.map((c) => c.command)).toEqual(["DescribeStacksCommand", "DescribeStacksCommand", "DescribeStacksCommand", "GetParameterCommand", "GetParameterCommand", "InvokeCommand", "InvokeCommand"]);
    expect(h.delays).toEqual([5000, 5000, 5000, 5000]);
  });

  it.each(["ResourceConflictException", "ENILimitReachedException", "EC2ThrottledException"])("invokes again after %s (the new version couldn't start yet)", async (name) => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [{ error: name }, ran([], 1)] });
    await h.onEvent(update(1, 2));
    expect(h.calls.filter((c) => c.command === "InvokeCommand")).toHaveLength(2);
  });

  it("gives up after 24 tries, 5 s apart (about 2 minutes for IAM)", async () => {
    const h = load({ DescribeStacksCommand: Array.from({ length: 30 }, () => ({ error: "AccessDenied" })) });
    await expect(h.onEvent(update(1, 2))).rejects.toThrow(`${MIGRATE_BEFORE_LIVE_FAILED} (nothing moved to the new release): AccessDenied: stand-in AccessDenied`);
    expect(h.calls).toHaveLength(24);
    expect(h.delays).toEqual(Array(23).fill(5000));
  });

  it("fails the stack when migrate fails, whatever the error says, and never sends it again", async () => {
    const h = load({
      DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")],
      GetParameterCommand: [found],
      InvokeCommand: [{ StatusCode: 200, FunctionError: "Unhandled", Payload: Buffer.from('{"errorMessage":"connect ETIMEDOUT 10.0.3.12:5432"}') }],
    });
    const failure = h.onEvent(update(1, 2));
    await expect(failure).rejects.toThrow(/^migrate-before-live failed \(nothing moved to the new release\): .*connect ETIMEDOUT 10\.0\.3\.12:5432/);
    expect(h.calls.filter((c) => c.command === "InvokeCommand")).toHaveLength(1);
  });

  it.each(["TimeoutError", "ServiceException", "Error"])("never invokes again after %s (the cron may have run)", async (name) => {
    const h = load({ DescribeStacksCommand: [stack("UPDATE_IN_PROGRESS")], GetParameterCommand: [found], InvokeCommand: [{ error: name }, ran([], 1)] });
    await expect(h.onEvent(update(1, 2))).rejects.toThrow(MIGRATE_BEFORE_LIVE_FAILED);
    expect(h.calls.filter((c) => c.command === "InvokeCommand")).toHaveLength(1);
  });
});
