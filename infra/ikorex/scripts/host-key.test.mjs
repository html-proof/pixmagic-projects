// node --test infra/ikorex/scripts/host-key.test.mjs (CI: the checks job)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hostKeyFingerprint, PINNED_FINGERPRINT, PINNED_HOST } from "./host-key.mjs";

test("the pinned host key in infra/ikorex/known_hosts is the one in the administrator's guide", () => {
  const knownHosts = readFileSync(new URL("../known_hosts", import.meta.url), "utf8");
  assert.equal(hostKeyFingerprint(knownHosts, PINNED_HOST), PINNED_FINGERPRINT);
  assert.equal(hostKeyFingerprint(knownHosts, "203.0.113.9"), null);
  // A key that isn't the guide's has another fingerprint.
  const other = knownHosts.replace(/AAAAC3NzaC1lZDI1NTE5AAAAI\S+/, "AAAAC3NzaC1lZDI1NTE5AAAAIGq0dxZ3fBDWfsUn0dUyuZbYKg8i0ZjV3Ng3Bf7PN0Ab");
  assert.notEqual(hostKeyFingerprint(other, PINNED_HOST), PINNED_FINGERPRINT);
});
