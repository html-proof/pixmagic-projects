import { describe, expect, it } from "vitest";
import { z } from "zod";
import { partialUpdate } from "../src/partialUpdate";
import { ruleUpdateSchema, templateUpdateSchema } from "../src/email";

describe("partialUpdate", () => {
  const rule = z
    .object({
      name: z.string().min(1),
      enabled: z.boolean().default(false),
      conditions: z.array(z.string()).default([]),
      mapping: z.object({ body: z.array(z.string()).default([]) }).prefault({}),
    })
    .strict();

  it("leaves out what the update doesn't mention, where .partial() would fill the defaults in", () => {
    expect(rule.partial().parse({ name: "Renamed" })).toEqual({ name: "Renamed", enabled: false, conditions: [], mapping: { body: [] } });
    expect(partialUpdate(rule).parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(partialUpdate(rule).parse({})).toEqual({});
  });

  it("still checks what the update does mention, and keeps the object's own rules", () => {
    expect(partialUpdate(rule).parse({ enabled: true, mapping: {} })).toEqual({ enabled: true, mapping: { body: [] } });
    expect(partialUpdate(rule).safeParse({ name: "" }).success).toBe(false);
    expect(partialUpdate(rule).safeParse({ name: "x", unknown: 1 }).success).toBe(false);
  });

  it("the email update schemas change only what they're sent", () => {
    expect(ruleUpdateSchema.parse({ name: "Welcome" })).toEqual({ name: "Welcome" });
    expect(templateUpdateSchema.parse({ status: "archived" })).toEqual({ status: "archived" });
  });
});
