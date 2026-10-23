/**
 * zod for every schema in this package: import `{ z }` from here, never from "zod" (lint enforces it).
 *
 * Zod 4 compiles object schemas with `new Function` and probes for it once, when the first object
 * schema is built. The site's CSP has no 'unsafe-eval', so in a browser that probe is reported as a
 * `securitypolicyviolation` on every page, even though zod catches the error (e2e console.spec
 * fails on it). Browsers therefore run jitless; Node (API, worker, Lambda) keeps the faster JIT.
 * This module runs before any module that imports it builds a schema, so the probe never happens.
 */
import { z } from "zod";

if (typeof document !== "undefined") z.config({ jitless: true });

export { z };

/**
 * Plain words for zod's own messages, for forms that list a schema's problems as "<label>: <text>":
 * `schema.safeParse(draft, { error: formIssue })`. A message the schema sets itself still wins, and
 * anything not covered here keeps zod's wording. Zod 4's defaults read like developer text ("Too
 * small: expected string to have >=1 characters", or a regex's source).
 */
export const formIssue: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return "required";
      if (issue.expected === "int") return "enter a whole number";
      if (issue.expected === "number") return "enter a number";
      return undefined;
    case "too_small": {
      const n = issue.minimum;
      if (issue.origin === "string") return n === 1 ? "required" : `at least ${n} characters`;
      if (issue.origin === "array" || issue.origin === "set") return n === 1 ? "add at least one" : `add at least ${n}`;
      if (issue.origin === "number" || issue.origin === "int") return issue.inclusive === false ? `more than ${n}` : `at least ${n}`;
      return undefined;
    }
    case "too_big": {
      const n = issue.maximum;
      if (issue.origin === "string") return `at most ${n} characters`;
      if (issue.origin === "array" || issue.origin === "set") return `at most ${n}`;
      if (issue.origin === "number" || issue.origin === "int") return issue.inclusive === false ? `less than ${n}` : `at most ${n}`;
      return undefined;
    }
    case "invalid_format":
      return issue.format === "email" ? "enter a valid email address" : "isn't valid";
    case "invalid_value":
      return "choose one of the options";
    default:
      return undefined;
  }
};
