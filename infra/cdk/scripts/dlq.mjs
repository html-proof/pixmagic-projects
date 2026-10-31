#!/usr/bin/env node
// The dead-letter queue (`insights-<env>-dlq`): what is parked there, and sending it back.
//
//   node infra/cdk/scripts/dlq.mjs [--env production] [--max 100]          what is parked (nothing moves)
//   node infra/cdk/scripts/dlq.mjs --redrive --yes [--rate 5]                back to the queues they came from
//   node infra/cdk/scripts/dlq.mjs --status                                 the last redrive's progress
//
// Jobs land in the DLQ only after SQS gave up on them (maxReceiveCount, after the worker's own
// retries): a crash, or a long outage. Look first, fix the cause, then redrive. Every job is safe
// to run twice: a text or email is claimed before it is sent, so a redriven send that already went
// out finds its row taken and stops (docs/automations.md, "Dead-letter queue").
//
// Peeking shows each job's kind and ids only, never its body: bodies can name a store's webhook.
// It receives with a visibility timeout of 0, so the messages stay where they are.
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const envName = opt("--env", "production");
const region = opt("--region", "ap-southeast-2");
const max = Math.min(1000, Math.max(1, Number(opt("--max", "100")) || 100));
const rate = Math.min(50, Math.max(1, Number(opt("--rate", "5")) || 5));
const aws = (a) => {
  const out = execFileSync("aws", [...a, "--region", region, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim() ? JSON.parse(out) : {};
};

const queueName = `insights-${envName}-dlq`;
const url = aws(["sqs", "get-queue-url", "--queue-name", queueName]).QueueUrl;
const attrs = aws(["sqs", "get-queue-attributes", "--queue-url", url, "--attribute-names", "QueueArn", "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]).Attributes;
console.log(`${queueName}: ${attrs.ApproximateNumberOfMessages} waiting, ${attrs.ApproximateNumberOfMessagesNotVisible} in flight`);

if (args.includes("--status")) {
  const tasks = aws(["sqs", "list-message-move-tasks", "--source-arn", attrs.QueueArn, "--max-results", "5"]).Results ?? [];
  for (const t of tasks) console.log(`${new Date(t.StartedTimestamp).toISOString()} ${t.Status}: ${t.ApproximateNumberOfMessagesMoved ?? 0} of ${t.ApproximateNumberOfMessagesToMove ?? "?"} moved${t.FailureReason ? ` (${t.FailureReason})` : ""}`);
  if (!tasks.length) console.log("No redrive has run.");
} else if (args.includes("--redrive")) {
  if (!args.includes("--yes")) {
    console.error("Redrive runs every parked job again. Look at them first (no flags), fix the cause, then add --yes.");
    process.exit(1);
  }
  // No destination: SQS returns each message to the queue it was dead-lettered from.
  const task = aws(["sqs", "start-message-move-task", "--source-arn", attrs.QueueArn, "--max-number-of-messages-per-second", String(rate)]);
  console.log(`Redrive started (${rate}/s): ${task.TaskHandle}. Follow it with --status.`);
} else {
  /** The job's kind and its ids, from a queue body like {"kind":"sms","jobId":"…"}; nothing else. */
  const summary = (body) => {
    try {
      const b = JSON.parse(body);
      const ids = Object.entries(b)
        .filter(([k, v]) => /(^id$|Id$)/.test(k) && typeof v === "string" && v.length <= 64)
        .map(([k, v]) => `${k}=${v}`);
      return { kind: typeof b.kind === "string" ? b.kind : typeof b.topic === "string" ? `webhook:${b.topic}` : "unknown", ids };
    } catch {
      return { kind: "unreadable", ids: [] };
    }
  };
  const seen = new Map();
  const byKind = new Map();
  for (let round = 0; seen.size < max && round < Math.ceil(max / 10) + 5; round++) {
    const r = aws(["sqs", "receive-message", "--queue-url", url, "--max-number-of-messages", "10", "--visibility-timeout", "0", "--wait-time-seconds", "1", "--attribute-names", "All"]);
    const msgs = r.Messages ?? [];
    if (!msgs.length) break;
    for (const m of msgs) {
      if (seen.has(m.MessageId)) continue;
      const s = summary(m.Body);
      seen.set(m.MessageId, s);
      byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
      console.log(`${new Date(Number(m.Attributes?.SentTimestamp ?? 0)).toISOString()}  received ${m.Attributes?.ApproximateReceiveCount ?? "?"}x  ${s.kind}  ${s.ids.join(" ")}`);
    }
  }
  console.log(`\n${seen.size} looked at (sampling can repeat or miss a few while others read the queue):`);
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
  console.log("\nFind each id's error in CloudWatch (/aws/lambda/insights-<env>-jobs), fix the cause, then --redrive --yes.");
}
