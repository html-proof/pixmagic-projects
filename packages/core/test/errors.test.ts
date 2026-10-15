import { describe, expect, it } from "vitest";
import { AppError, EmailError, providerDetail, StaffError, WhatsappError } from "../src/index.js";

describe("errors", () => {
  it("every module's rule violation is an AppError the API can answer as is", () => {
    for (const err of [new StaffError(409, "locked", "Locked."), new EmailError("Gone.", 410, "gone"), new WhatsappError("Connect first.", 409, "not_connected")]) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.name).not.toBe("AppError");
    }
    expect(new StaffError(422, "blocked", "Blocked.", ["x"])).toMatchObject({ status: 422, code: "blocked", message: "Blocked.", detail: ["x"] });
  });

  it("shows a provider's reason without links, tokens or a wall of text", () => {
    expect(providerDetail("(#100) Invalid parameter")).toBe("(#100) Invalid parameter");
    expect(providerDetail("See https://developers.facebook.com/docs/x?access_token=abc for\n details")).toBe("See [link] for details");
    expect(providerDetail("token EAAGm0PX4ZCpsBAKZB0123456789abcdefghijklmnop rejected")).toBe("token […] rejected");
    expect(providerDetail(null)).toBe("");
    const long = providerDetail("word ".repeat(100));
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
