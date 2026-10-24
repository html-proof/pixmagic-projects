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
