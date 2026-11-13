// What both database copies (copy-db.mjs: RDS → the iKorex server; copy-db-back.mjs: back again)
// run from the owner's PC: the AWS CLI (signed in with `aws login`), SSH to the server's pinned host
// key only, AWS's admin host through Systems Manager, the artifacts bucket's db-export/ prefix and
// the report in ~/insights-backups. The parts that touch nothing are in copy-db-lib.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hostKeyFingerprint, PINNED_FINGERPRINT } from "./copy-db-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** `--name value` from the command line, or `fallback`. */
export const option = (args, name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
export const step = (msg) => console.log(`\n== ${msg}`);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 20261108T093000Z: names the dumps, the report and (rollback) the snapshot. */
export const timeStamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");

/** copy-db.sh as the hosts run it: LF only (bash on Linux refuses CR). */
export const copyScript = () => readFileSync(join(here, "copy-db.sh"), "utf8").replace(/\r\n/g, "\n");

/** A command's stdout; its stderr on this terminal. */
export const sh = (cmd, cmdArgs, input) =>
  execFileSync(cmd, cmdArgs, { encoding: "utf8", input, maxBuffer: 1024 * 1024 * 64, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

/** The AWS CLI in one Region, its answer parsed (null when it prints nothing, like `wait`). */
export const awsCli = (region) => (cliArgs) => JSON.parse(sh("aws", [...cliArgs, "--region", region, "--output", "json"]) || "null");

/** A CloudFormation stack's resource of `type` whose logical id starts with `logicalPrefix`. */
export function stackResource(aws, stackName, logicalPrefix, type) {
  const all = aws(["cloudformation", "list-stack-resources", "--stack-name", stackName]).StackResourceSummaries;
  const hit = all.find((r) => r.ResourceType === type && r.LogicalResourceId.startsWith(logicalPrefix));
  if (!hit) throw new Error(`No ${type} ${logicalPrefix}* in ${stackName}`);
  return hit.PhysicalResourceId;
}

/**
 * The server over SSH: only to the host key the administrator's guide gives (infra/ikorex/known_hosts),
 * only with this key. `remote` runs one command there, its stdin from `input`; a passphrase prompt,
 * if any, is on this terminal.
 */
export function server({ sshTarget, identity, project }) {
  const knownHosts = resolve(here, "../known_hosts");
  const host = sshTarget.split("@").pop();
  if (hostKeyFingerprint(readFileSync(knownHosts, "utf8"), host) !== PINNED_FINGERPRINT) {
    throw new Error(`${knownHosts} doesn't hold the host key whose fingerprint the administrator's guide gives (${PINNED_FINGERPRINT}) for ${host}`);
  }
  const sshArgs = ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=20", "-i", identity, sshTarget];
  // Windows' own OpenSSH: it uses the Windows ssh-agent; Git Bash's ssh, first on its PATH, doesn't.
  // SHIP_SSH (as in ship.sh) names another ssh program: Git Bash's own, when its agent holds the key
  // (SSH_AUTH_SOCK), which needs no Windows service (PRODUCTION_DEPLOYMENT_GUIDE.md, "From a Windows PC").
  const windowsSsh = "C:/Windows/System32/OpenSSH/ssh.exe";
  const sshExe = process.env.SHIP_SSH || (process.platform === "win32" && existsSync(windowsSsh) ? windowsSsh : "ssh");
  function remote(command, input) {
    const r = spawnSync(sshExe, [...sshArgs, command], { input, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, stdio: ["pipe", "pipe", "inherit"] });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`on the server, "${command}" exited ${r.status}`);
    return r.stdout;
  }
  const inProject = (cmd) => `cd ~/${project} && ${cmd}`;
  const compose = (cmd) => inProject(`docker compose -p ${project} ${cmd}`);
  return { remote, inProject, compose };
}

/**
 * AWS's admin host (inside the VPC: RDS has no public address), reached only through Systems
 * Manager. `ssm` runs one script there and returns its stdout.
 */
export function adminHost(aws, instanceId) {
  async function start() {
    aws(["ec2", "start-instances", "--instance-ids", instanceId]);
    for (let i = 0; ; i++) {
      const info = aws(["ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`]).InstanceInformationList;
      if (info[0]?.PingStatus === "Online") break;
      if (i > 60) throw new Error("The admin host did not come online in Systems Manager within 10 minutes");
      await sleep(10_000);
    }
    console.log(`${instanceId} online`);
  }
  function stop() {
    aws(["ec2", "stop-instances", "--instance-ids", instanceId]);
    console.log(`${instanceId} stopping`);
  }
  async function ssm(script, label) {
    const cmd = aws(["ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript", "--comment", label, "--timeout-seconds", "600", "--parameters", JSON.stringify({ commands: [script], executionTimeout: ["3600"] })]).Command;
    for (;;) {
      await sleep(5_000);
      let inv;
      try {
        inv = aws(["ssm", "get-command-invocation", "--command-id", cmd.CommandId, "--instance-id", instanceId]);
      } catch {
        continue; // not registered yet
      }
      if (["Pending", "InProgress", "Delayed"].includes(inv.Status)) continue;
      if (inv.Status !== "Success") throw new Error(`${label} failed (${inv.Status}):\n${inv.StandardErrorContent}\n${inv.StandardOutputContent}`);
      // Systems Manager keeps the first 24,000 characters: the result line is the only stdout.
      if (inv.StandardOutputContent.length >= 24_000) throw new Error(`${label}: the output was cut off by Systems Manager`);
      return inv.StandardOutputContent;
    }
  }
  return { start, stop, ssm };
}

/** Every version under one db-export/<time>/ prefix, deleted (the bucket's own rule: after a day). */
export function removeExport(aws, bucket, exportPrefix) {
  const listed = aws(["s3api", "list-object-versions", "--bucket", bucket, "--prefix", exportPrefix]) ?? {};
  const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
  if (objects.length) aws(["s3api", "delete-objects", "--bucket", bucket, "--delete", JSON.stringify({ Objects: objects, Quiet: true })]);
  console.log(`deleted ${objects.length} object version(s) under s3://${bucket}/${exportPrefix}`);
}

/** The run's report (counts, sizes, checksums and timings: never data) in ~/insights-backups. */
export function runReport(name, data) {
  const dir = join(homedir(), "insights-backups");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}-${data.stamp}.json`);
  const save = () => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  const timed = async (stepName, fn) => {
    const t0 = Date.now();
    const out = await fn();
    data.steps[stepName] = { seconds: Math.round((Date.now() - t0) / 1000) };
    return out;
  };
  return { file, save, timed };
}
