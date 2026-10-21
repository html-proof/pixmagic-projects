import { describe, expect, it } from "vitest";
import { ApiError, apiFailure, readApiResponse } from "../../../apps/web/src/lib/apiResponse.js";

describe("browser API response errors", () => {
  it("normalizes interrupted body downloads into network errors", async () => {
    const response = new Response("body");
    response.text = () => Promise.reject(new Error("connection reset"));
    await expect(readApiResponse(response)).rejects.toMatchObject({ name: "ApiError", status: 0, code: "network" });
  });
  it.each([null, "upstream failure", [], { error: 123, message: {} }])("normalizes malformed error envelopes: %j", (body) => {
    expect(apiFailure(503, body)).toMatchObject({ status: 503, code: "error", message: "Request failed" });
  });
  it("retains error details and the shared-session marker", () => {
    const body = { error: "unauthenticated", message: "Session expired", detail: "reason", problems: ["field"] };
    const error = apiFailure(401, body);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "unauthenticated", message: "Session expired", data: body, sessionLeft: false });
    error.sessionLeft = true;
    expect(error.sessionLeft).toBe(true);
  });
  it("rejects non-JSON success bodies but tolerates upstream error pages", async () => {
    await expect(readApiResponse(new Response("<html>Oops</html>"))).rejects.toMatchObject({ code: "bad_response" });
    await expect(readApiResponse(new Response("<html>Unavailable</html>", { status: 503 }))).resolves.toEqual({});
  });
  it("preserves successful arrays, null, JSON and empty responses", async () => {
    for (const value of [[1, 2], null, { ok: true }]) {
      await expect(readApiResponse(new Response(JSON.stringify(value)))).resolves.toEqual(value);
    }
    await expect(readApiResponse(new Response(null, { status: 204 }))).resolves.toEqual({});
  });
});
