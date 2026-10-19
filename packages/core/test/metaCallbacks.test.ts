import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { META_SIGNED_REQUEST_MAX_AGE_S, verifyMetaSignedRequest } from "../src/index.js";

/**
 * Meta's signed_request, as its deauthorize and data deletion callbacks send it: base64url of the
 * HMAC-SHA256 of the still-encoded payload with the app secret, a dot, then base64url of the JSON
 * payload (https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback).
 * Signed here for real, the way Meta's sample code does it.
 */

const SECRET = "meta_secret";
const now = Date.parse("2026-10-19T12:00:00Z");
const issued = Math.floor(now / 1000) - 60;

function signed(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

describe("Meta's signed_request", () => {
  it("names the person when Meta signed it with this app's secret", () => {
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: "218471" }), SECRET, now)).toEqual({ userId: "218471", issuedAt: issued });
    // A numeric id, and the signature with base64 padding left on.
    const s = signed({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: 218471, expires: issued + 3600 });
    expect(verifyMetaSignedRequest(s.replace(".", "=."), SECRET, now)).toMatchObject({ userId: "218471" });
  });

  it("refuses one signed with another secret, changed after signing, or not a signed request at all", () => {
    const good = signed({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: "218471" });
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: "218471" }, "another_secret"), SECRET, now)).toBeNull();
    // Someone else's id put into a payload signed for this one.
    const [sig] = good.split(".");
    const forged = `${sig}.${Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: "999" })).toString("base64url")}`;
    expect(verifyMetaSignedRequest(forged, SECRET, now)).toBeNull();
    for (const bad of [undefined, null, 42, "", "nodot", ".payload", `${sig}.`, `${sig}.!!!`, "a".repeat(9000)]) {
      expect(verifyMetaSignedRequest(bad, SECRET, now)).toBeNull();
    }
    // Without the app secret nothing verifies.
    expect(verifyMetaSignedRequest(good, "", now)).toBeNull();
  });

  it("requires HMAC-SHA256, an app-scoped user id, and an issued_at that is recent and not from the future", () => {
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA1", issued_at: issued, user_id: "1" }), SECRET, now)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ issued_at: issued, user_id: "1" }), SECRET, now)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: issued }), SECRET, now)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: issued, user_id: "12a" }), SECRET, now)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "1" }), SECRET, now)).toBeNull();
    const nowS = Math.floor(now / 1000);
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: nowS - META_SIGNED_REQUEST_MAX_AGE_S - 1, user_id: "1" }), SECRET, now)).toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: nowS - META_SIGNED_REQUEST_MAX_AGE_S + 60, user_id: "1" }), SECRET, now)).not.toBeNull();
    expect(verifyMetaSignedRequest(signed({ algorithm: "HMAC-SHA256", issued_at: nowS + 3600, user_id: "1" }), SECRET, now)).toBeNull();
    // A payload that isn't JSON, signed all the same.
    const body = Buffer.from("not json").toString("base64url");
    expect(verifyMetaSignedRequest(`${createHmac("sha256", SECRET).update(body).digest("base64url")}.${body}`, SECRET, now)).toBeNull();
  });
});
