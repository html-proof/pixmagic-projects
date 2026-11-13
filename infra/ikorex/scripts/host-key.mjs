// The server's host key, as the administrator's SSH guide gives it: ship.sh connects only to the
// key in infra/ikorex/known_hosts, and host-key.test.mjs checks that file still holds this one.
import { createHash } from "node:crypto";

/** The fingerprint the administrator's SSH guide (5 Nov 2026) gives for the server's host key. */
export const PINNED_HOST = "103.146.112.176";
export const PINNED_FINGERPRINT = "SHA256:5whPPmUOtct7uImi8hLLqyVU5vv1j470FAfLI5Or+TA";

/** OpenSSH's SHA256 fingerprint of the ed25519 key a known_hosts file holds for `host`. */
export function hostKeyFingerprint(knownHosts, host) {
  const line = knownHosts
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((f) => f.length >= 3 && !f[0].startsWith("#") && f[0].split(",").includes(host) && f[1] === "ssh-ed25519");
  if (!line) return null;
  return `SHA256:${createHash("sha256").update(Buffer.from(line[2], "base64")).digest("base64").replace(/=+$/, "")}`;
}
