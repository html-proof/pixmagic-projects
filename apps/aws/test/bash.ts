import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The bash the tests run the server's scripts with (infra/ikorex/scripts): Git for Windows' on
 * Windows (System32's bash.exe is WSL's), the system's elsewhere; null when there is none.
 */
export function findBash(): string | null {
  try {
    if (process.platform !== "win32") return execFileSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).trim() || null;
    const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const bash = resolve(exec, "../../../bin/bash.exe");
    return existsSync(bash) ? bash : null;
  } catch {
    return null;
  }
}
