import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBash } from "./bash.js";

/**
 * Deploy to iKorex's two halves (.github/workflows/ikorex-deploy.yml) without the server:
 * `ship.sh pack` (what a release holds, and what it leaves out), `ship.sh send` through a stand-in
 * ssh to a stand-in home folder, and the server's gate for the deploy key (`ssh-gate.sh`: the two
 * requests it accepts, and everything it refuses). Docker and deploy.sh are stand-ins that record
 * how they were called. Skipped without bash (Git for Windows' on Windows).
 */
const root = resolve(__dirname, "../../..");
const bash = findBash();
const slash = (p: string) => p.replace(/\\/g, "/");

describe.skipIf(!bash)("Deploy to iKorex: ship.sh and the server's gate", { timeout: 60_000 }, () => {
  const work = slash(mkdtempSync(join(tmpdir(), "ikorex-ship-")));
  const repo = `${work}/repo`;
  const stubs = `${work}/stubs`;
  const log = `${work}/calls.log`;
  const release = `${work}/release.tgz`;
  const gate = `${repo}/infra/ikorex/scripts/ssh-gate.sh`;
  let tag = "";
  let home = "";

  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text.replace(/\r\n/g, "\n"));
  };
  // A stand-in program: found on PATH and run by name, so it needs the executable bit (Linux
  // refuses it with 126 without; Git for Windows runs anything that starts with "#!").
  const program = (path: string, text: string) => {
    write(path, text);
    chmodSync(path, 0o755);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";

  function run(script: string, args: string[], env: Record<string, string> = {}, input?: Buffer) {
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.SSH_ORIGINAL_COMMAND;
    delete base.SHIP_GATED;
    delete base.SHIP_SSH_CONFIG;
    const r = spawnSync(bash!, [script, ...args], {
      cwd: work,
      input,
      encoding: "utf8",
      env: { ...base, [pathKey]: `${stubs}${delimiter}${process.env[pathKey] ?? ""}`, HOME: home, STUB_LOG: log, STUB_GATE: gate, ...env },
    });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  }
  const freshHome = () => {
    home = `${work}/home-${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(home);
    rmSync(log, { force: true });
  };
  const listing = (file: string) => execFileSync(bash!, ["-c", 'tar -tzf - < "$1"', "list", file], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);

  beforeAll(() => {
    // A repository shaped like this one: the real scripts and host key, a stand-in bundle builder and deploy.sh.
    write(`${repo}/.gitignore`, ["apps/aws/dist/", "infra/ikorex/env/*.env", "infra/ikorex/.env", "infra/ikorex/monitoring/alertmanager.yml", "infra/ikorex/monitoring/smtp_password", ""].join("\n"));
    write(
      `${repo}/apps/aws/scripts/build-server.mjs`,
      `import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("apps/aws/dist/server", { recursive: true });\nwriteFileSync("apps/aws/dist/server/server.mjs", "built " + process.argv.slice(2).join(" "));\n`,
    );
    for (const f of ["ship.sh", "ssh-gate.sh"]) write(`${repo}/infra/ikorex/scripts/${f}`, readFileSync(join(root, "infra/ikorex/scripts", f), "utf8"));
    copyFileSync(join(root, "infra/ikorex/known_hosts"), `${repo}/infra/ikorex/known_hosts`);
    write(`${repo}/infra/ikorex/scripts/deploy.sh`, `#!/bin/bash\necho "deploy.sh $* in $(basename "$PWD")" >> "$STUB_LOG"\n`);
    write(`${repo}/infra/ikorex/docker-compose.yml`, "name: bizinsights\n");
    write(`${repo}/infra/ikorex/Dockerfile`, "FROM node:24-bookworm-slim\n");
    write(`${repo}/infra/ikorex/env/app.env.example`, "APP_URL=\n");
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "release");
    tag = git("rev-parse", "--short=12", "HEAD");
    // The PC's own copies of the server's settings: ignored, and never packed.
    write(`${repo}/infra/ikorex/env/app.env`, "SESSION_SECRET=from-the-pc\n");
    write(`${repo}/infra/ikorex/.env`, "APP_TAG=from-the-pc\n");
    write(`${repo}/infra/ikorex/monitoring/alertmanager.yml`, "pc\n");
    write(`${repo}/infra/ikorex/monitoring/smtp_password`, "pc\n");

    // ssh: the options it was given, then the request run as sshd would (the gate with the request
    // in SSH_ORIGINAL_COMMAND for the deploy key, a shell for the owner's key). docker: recorded.
    program(
      `${stubs}/ssh`,
      [
        "#!/bin/bash",
        'opts=""',
        'while [[ "${1:-}" == -* ]]; do opts="$opts $1 $2"; shift 2; done',
        'target="$1"; shift',
        'echo "ssh $target [$*]$opts" >> "$STUB_LOG"',
        'if [ "${STUB_FORCED:-}" = 1 ]; then SSH_ORIGINAL_COMMAND="$*" exec bash "$STUB_GATE"; fi',
        'exec bash -c "$*"',
        "",
      ].join("\n"),
    );
    program(`${stubs}/docker`, '#!/bin/bash\necho "docker $*" >> "$STUB_LOG"\n');
    write(`${work}/ssh_config`, "Host ikorex\n  HostName 192.0.2.1\n");
    freshHome();
  }, 60_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("pack: the bundle under releases/<tag>/server and infra/ikorex at the top, without the server's settings", () => {
    const r = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["pack", release, "--skip-web"]);
    expect(r.out).toContain(`packed ${tag}`);
    expect(r.code).toBe(0);
    const files = listing(release);
    expect(files).toEqual(expect.arrayContaining([`releases/${tag}/server/server.mjs`, "docker-compose.yml", "Dockerfile", "known_hosts", "scripts/ship.sh", "scripts/ssh-gate.sh", "scripts/deploy.sh", "env/app.env.example"]));
    for (const f of ["env/app.env", ".env", "monitoring/alertmanager.yml", "monitoring/smtp_password"]) expect(files).not.toContain(f);
    expect(files.some((f) => f.startsWith("apps/") || f.startsWith("infra/"))).toBe(false);
    expect(execFileSync(bash!, ["-c", `tar -xzOf - releases/${tag}/server/server.mjs < "$1"`, "x", release], { encoding: "utf8" })).toBe("built --skip-web");
  });

  it("pack refuses a checkout with uncommitted changes", () => {
    write(`${repo}/stray.txt`, "x");
    try {
      const r = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["pack", `${work}/dirty.tgz`, "--skip-web"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("uncommitted changes");
      expect(existsSync(`${work}/dirty.tgz`)).toBe(false);
    } finally {
      rmSync(`${repo}/stray.txt`);
    }
  });

  it("send with the deploy key: receive and deploy through the gate, to the pinned host key", () => {
    freshHome();
    write(`${home}/bizinsights-staging/env/app.env`, "SESSION_SECRET=on-the-server\n");
    const r = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["send", "ikorex", "bizinsights-staging", release, tag], {
      SHIP_GATED: "1",
      SHIP_SSH: `${stubs}/ssh`,
      SHIP_SSH_CONFIG: `${work}/ssh_config`,
      STUB_FORCED: "1",
    });
    expect(r.out).toContain(`sending ${tag} to ikorex:~/bizinsights-staging`);
    expect(r.code).toBe(0);
    const c = calls();
    expect(c[0]).toMatch(new RegExp(`^ssh ikorex \\[receive bizinsights-staging ${tag}\\] -F ${work}/ssh_config -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\\S*infra/ikorex/known_hosts -o IdentitiesOnly=yes$`));
    expect(c.slice(1)).toEqual([
      expect.stringMatching(new RegExp(`^ssh ikorex \\[deploy bizinsights-staging ${tag}\\]`)),
      `docker build -q -f Dockerfile -t bizinsights:${tag} releases/${tag}/server`,
      `deploy.sh ${tag} in bizinsights-staging`,
    ]);
    expect(readFileSync(`${home}/bizinsights-staging/releases/${tag}/server/server.mjs`, "utf8")).toBe("built --skip-web");
    expect(readFileSync(`${home}/bizinsights-staging/env/app.env`, "utf8")).toBe("SESSION_SECRET=on-the-server\n");
  });

  it("send with the owner's key: the same, as shell commands", () => {
    freshHome();
    const r = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["send", "deployer@192.0.2.1", "bizinsights", release], { SHIP_SSH: `${stubs}/ssh` });
    expect(r.code).toBe(0);
    const c = calls();
    expect(c).toHaveLength(4);
    expect(c[0]).toContain("tar -xzf -");
    expect(c[1]).toContain(`./scripts/ssh-gate.sh deploy bizinsights ${tag}`);
    expect(c.slice(2)).toEqual([`docker build -q -f Dockerfile -t bizinsights:${tag} releases/${tag}/server`, `deploy.sh ${tag} in bizinsights`]);
    expect(existsSync(`${home}/bizinsights/releases/${tag}/server/server.mjs`)).toBe(true);
  });

  it("send refuses another commit's release, and a project that isn't one of the two", () => {
    freshHome();
    const other = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["send", "ikorex", "bizinsights", release, "0123456789ab"], { SHIP_SSH: `${stubs}/ssh` });
    expect(other.code).toBe(1);
    expect(other.out).toContain(`is release ${tag}, not 0123456789ab`);
    const project = run(`${repo}/infra/ikorex/scripts/ship.sh`, ["send", "ikorex", "websites", release], { SHIP_SSH: `${stubs}/ssh` });
    expect(project.code).toBe(2);
    expect(calls()).toEqual([]);
  });

  it.each([
    ["an interactive login", ""],
    ["a shell", "bash"],
    ["another command", "cat ~/.ssh/authorized_keys"],
    ["another project", `deploy websites ${"a".repeat(12)}`],
    ["a short tag", "deploy bizinsights abc123"],
    ["an upper-case tag", `deploy bizinsights ${"A".repeat(12)}`],
    ["a tag with a command after it", `deploy bizinsights ${"a".repeat(12)};touch pwned`],
    ["a substitution", "receive bizinsights-staging $(touch pwned)"],
    ["a fourth word", `deploy bizinsights ${"a".repeat(12)} now`],
    ["a second line", `deploy bizinsights ${"a".repeat(12)}\ntouch pwned`],
  ])("the gate refuses %s", (_what, request) => {
    freshHome();
    const r = run(gate, [], { SSH_ORIGINAL_COMMAND: request }, Buffer.from(""));
    expect(r.code).toBe(2);
    expect(r.out).toContain("ssh-gate: refused");
    expect(calls()).toEqual([]);
    expect(existsSync(`${home}/bizinsights`) || existsSync(`${home}/bizinsights-staging`)).toBe(false);
    expect(existsSync(`${work}/pwned`) || existsSync(`${home}/pwned`)).toBe(false);
  });

  it("the gate's receive keeps the server's settings whatever the archive holds", () => {
    freshHome();
    const dir = `${home}/bizinsights-staging`;
    write(`${dir}/env/app.env`, "on the server\n");
    write(`${dir}/.env`, "APP_TAG=old\n");
    const src = `${work}/crafted`;
    for (const f of [`releases/${tag}/server/server.mjs`, "scripts/deploy.sh", "env/app.env", ".env", "monitoring/smtp_password", "monitoring/alertmanager.yml"]) write(`${src}/${f}`, "from the archive\n");
    const archive = execFileSync(bash!, ["-c", 'cd "$1" && tar -czf - releases scripts env .env monitoring', "pack", src]);
    const r = run(gate, [], { SSH_ORIGINAL_COMMAND: `receive bizinsights-staging ${tag}` }, archive);
    expect(r.code).toBe(0);
    expect(readFileSync(`${dir}/env/app.env`, "utf8")).toBe("on the server\n");
    expect(readFileSync(`${dir}/.env`, "utf8")).toBe("APP_TAG=old\n");
    expect(existsSync(`${dir}/monitoring/smtp_password`) || existsSync(`${dir}/monitoring/alertmanager.yml`)).toBe(false);
    expect(readFileSync(`${dir}/releases/${tag}/server/server.mjs`, "utf8")).toBe("from the archive\n");
  });

  it("the gate deploys only a release it has received", () => {
    freshHome();
    const r = run(gate, [], { SSH_ORIGINAL_COMMAND: `deploy bizinsights ${tag}` });
    expect(r.code).toBe(1);
    expect(r.out).toContain("receive it first");
    expect(calls()).toEqual([]);
  });
});
