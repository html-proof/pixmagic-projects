import { describe, expect, it } from "vitest";
import { formIssue, z } from "../src/zod";
import { smsSenderSchema } from "../src/sms";

const words = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value, { error: formIssue });
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("zod", () => {
  it("keeps the JIT outside a browser", () => {
    expect(z.config().jitless).toBeFalsy();
  });

  it("formIssue says zod's problems in plain words", () => {
    const form = z.object({
      name: z.string().trim().min(1).max(5),
      code: z.string().min(3),
      days: z.number().int().min(1).max(30),
      share: z.number().gt(0).lt(1),
      countries: z.array(z.string()).min(1).max(2),
      kind: z.enum(["a", "b"]),
      email: z.email(),
      id: z.string().regex(/^\d+$/),
    });
    expect(words(form, { name: " ", code: "ab", days: 1.5, share: 0, countries: [], kind: "c", email: "x", id: "a" })).toEqual([
      "name: required",
      "code: at least 3 characters",
      "days: enter a whole number",
      "share: more than 0",
      "countries: add at least one",
      "kind: choose one of the options",
      "email: enter a valid email address",
      "id: isn't valid",
    ]);
    expect(words(form, { name: "abcdef", code: "abc", days: 31, share: 1, countries: ["AU", "NZ", "US"], kind: "a", email: "a@b.co", id: "1" })).toEqual([
      "name: at most 5 characters",
      "days: at most 30",
      "share: less than 1",
      "countries: at most 2",
    ]);
    expect(words(form, {})[0]).toBe("name: required");
    expect(words(z.object({ n: z.number() }), { n: Number.NaN })).toEqual(["n: enter a number"]);
  });

  it("formIssue leaves a schema's own message alone", () => {
    const sender = { senderType: "sender_id", originationIdentity: "My Brand", countries: ["AU"], monthlyBudgetUsd: 10 };
    expect(words(smsSenderSchema, sender)).toEqual(["originationIdentity: Paste it exactly as AWS shows it, with no spaces."]);
  });
});
