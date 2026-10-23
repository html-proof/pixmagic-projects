import { describe, expect, it } from "vitest";
import { codeInText } from "../src/auth.js";

describe("the code on the clipboard (Paste code)", () => {
  it("finds the code alone, in a line of the email, or in all of it", () => {
    expect(codeInText("482913")).toBe("482913");
    expect(codeInText("  482913\n")).toBe("482913");
    expect(codeInText("Your bizinsights verification code is: 482913")).toBe("482913");
    const email = ["Hello Alex,", "", "Use the verification code below to continue.", "", "    048291", "", "This code expires in 60 seconds."].join("\n");
    expect(codeInText(email)).toBe("048291");
  });

  it("joins a code split in two, as some apps show it", () => {
    expect(codeInText("482 913")).toBe("482913");
    expect(codeInText("482-913")).toBe("482913");
    expect(codeInText("482\u00a0913")).toBe("482913");
  });

  it("takes no part of a longer number, and nothing from text without a code", () => {
    expect(codeInText("Order #1048291 shipped")).toBeNull();
    expect(codeInText("Call 0412345678")).toBeNull();
    expect(codeInText("12345")).toBeNull();
    expect(codeInText("1234-5678")).toBeNull();
    expect(codeInText("")).toBeNull();
    expect(codeInText("no code here")).toBeNull();
  });
});
