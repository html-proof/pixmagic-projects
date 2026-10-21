import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../../../apps/web/src/lib/apiClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser API transport", () => {
  it("normalizes interrupted body downloads into retryable network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ text: () => Promise.reject(new Error("connection reset")) }));
    await expect(api("/me")).rejects.toMatchObject({ name: "ApiError", status: 0, code: "network" });
  });
  it.each([null, "upstream failure", { error: 123, message: {} }])("handles malformed JSON error envelopes: %j", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 503 })));
    await expect(api("/me")).rejects.toMatchObject({ status: 503, code: "error", message: "Request failed" });
  });
  it("preserves API error codes and rejects non-JSON success bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"permission","message":"Access denied"}', { status: 403 })));
    await expect(api("/me")).rejects.toMatchObject({ status: 403, code: "permission", message: "Access denied" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Unexpected</html>")));
    await expect(api("/me")).rejects.toBeInstanceOf(ApiError);
  });
});
