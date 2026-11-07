import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBash } from "./bash.js";

/**
 * The iKorex server's containers keep the isolation the migration promised the administrator
 * (docs/ikorex-migration/SECURITY_AUDIT.md): no published port, no host network, no privileged
 * container, no Linux capability beyond the database entrypoint's five, the Docker socket only in
 * the optional log collector, limits on every container. Checked on what Compose itself makes of
 * the files (`docker compose config`, which needs the Docker CLI but not a running Docker); skipped
 * without the CLI. And the server's scripts refuse a CHANGE_ME placeholder left in a settings file.
 */
const root = resolve(__dirname, "../../..");
const hasCompose = (() => {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();
const bash = findBash();

interface Service {
  image?: string;
  ports?: unknown[];
  network_mode?: string;
  privileged?: boolean;
  pid?: string;
  cap_drop?: string[];
  cap_add?: string[];
  read_only?: boolean;
  security_opt?: string[];
  mem_limit?: number | string;
  cpus?: number | string;
  user?: string;
  volumes?: Array<{ type: string; source?: string; target: string; read_only?: boolean }>;
}

const work = mkdtempSync(join(tmpdir(), "ikorex-compose-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
function stage(): string {
  // The server's folder as ship.sh leaves it: env files made from their examples, .env with a tag.
  const dir = mkdtempSync(join(work, "p-"));
  cpSync(join(root, "infra/ikorex"), dir, { recursive: true });
  for (const f of readdirSync(join(dir, "env")).filter((f) => f.endsWith(".example"))) cpSync(join(dir, "env", f), join(dir, "env", f.replace(/\.example$/, "")));
  writeFileSync(join(dir, ".env"), "APP_TAG=test\nSCHEDULES=off\n");
  writeFileSync(join(dir, "monitoring/alertmanager.yml"), "");
  writeFileSync(join(dir, "monitoring/smtp_password"), "");
  return dir;
}
function render(dir: string, file: string, profiles: string[]): Record<string, Service> {
  const args = ["compose", "-f", file, ...profiles.flatMap((p) => ["--profile", p]), "config", "--format", "json"];
  return JSON.parse(execFileSync("docker", args, { cwd: dir, encoding: "utf8", timeout: 60_000 })).services;
}

describe.skipIf(!hasCompose)("the iKorex server's containers (docker compose config)", () => {
  let all: Record<string, Service>;
  beforeAll(() => {
    const dir = stage();
    all = { ...render(dir, "docker-compose.yml", ["admin"]), ...render(dir, "docker-compose.monitoring.yml", ["logs"]) };
  }, 120_000);

  it("renders every service of both projects, the optional ones included", () => {
    expect(Object.keys(all).sort()).toEqual(
      ["admin", "alertmanager", "alloy", "backup", "cloudflared", "evolution", "grafana", "loki", "node-exporter", "postgres", "postgres-exporter", "prometheus", "web", "worker"].sort(),
    );
  });

  it("publishes no port, shares no host network and runs nothing privileged", () => {
    for (const [name, s] of Object.entries(all)) {
      expect(s.ports ?? [], name).toEqual([]);
      expect(s.network_mode, name).toBeUndefined();
      expect(s.privileged ?? false, name).toBe(false);
    }
  });

  it("drops every Linux capability, and gives back only the database entrypoint's five", () => {
    for (const [name, s] of Object.entries(all)) {
      expect(s.cap_drop, name).toEqual(["ALL"]);
      expect(s.security_opt, name).toContain("no-new-privileges:true");
      if (name === "postgres") expect([...(s.cap_add ?? [])].sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]);
      else expect(s.cap_add ?? [], name).toEqual([]);
    }
  });

  it("limits every container's memory and CPU, so the server's websites, n8n and CCTV tunnel keep theirs", () => {
    for (const [name, s] of Object.entries(all)) {
      expect(Number(s.mem_limit), name).toBeGreaterThan(0);
      expect(Number(s.cpus), name).toBeGreaterThan(0);
    }
  });

  it("mounts the Docker socket only in the optional log collector, read-only, and the host's files only read-only", () => {
    for (const [name, s] of Object.entries(all)) {
      for (const v of (s.volumes ?? []).filter((v) => v.type === "bind")) {
        if (v.source?.endsWith("docker.sock")) {
          expect(name).toBe("alloy");
          expect(v.read_only).toBe(true);
          continue;
        }
        // Binds into the project's own folder (configuration, read-only) or the host's / for node-exporter.
        expect(v.read_only, `${name} ${v.target}`).toBe(true);
        if (!v.source?.startsWith(resolve(work))) expect([name, v.source]).toEqual(["node-exporter", "/"]);
      }
      if (s.pid === "host") expect(name).toBe("node-exporter");
    }
  });

  it("runs the app's own containers and the tunnel read-only", () => {
    for (const name of ["web", "worker", "admin", "cloudflared", "prometheus", "alertmanager", "node-exporter", "postgres-exporter"]) expect(all[name]!.read_only, name).toBe(true);
  });
});

describe.skipIf(!bash)("the server's scripts refuse placeholder passwords", () => {
  const run = (dir: string, script: string, args: string[]) =>
    new Promise<{ code: number; out: string }>((done) =>
      execFile(bash!, [join(dir, script).replace(/\\/g, "/"), ...args], { cwd: dir }, (err, stdout, stderr) => done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr })),
    );

  it("deploy.sh stops before anything runs when an env file still says CHANGE_ME", async () => {
    const dir = stage();
    // owner.env as copied from its example: CHANGE_ME passwords. Nothing else is reached (no Docker needed).
    const r = await run(dir, "scripts/deploy.sh", ["abc123"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/placeholder values \(CHANGE_ME\) still in: .*env\/owner\.env/);
  });

  it("render-monitoring.sh does too (Grafana's admin password)", async () => {
    const dir = stage();
    writeFileSync(join(dir, "env/alerting.env"), "ALERT_EMAIL_TO=a@example.com\nALERT_EMAIL_FROM=b@example.com\nRESEND_SMTP_PASSWORD=x\n");
    const r = await run(dir, "scripts/render-monitoring.sh", []);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/placeholder values \(CHANGE_ME\) still in: .*env\/monitoring\.env/);
  });
});
