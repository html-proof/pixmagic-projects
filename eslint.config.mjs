// Lint for every workspace: `pnpm lint` (CI runs it). Type errors are TypeScript's job
// (`pnpm typecheck`); this catches what the compiler doesn't: hooks used wrongly or with stale
// dependencies, unused code, `any`, and the usual JavaScript pitfalls.
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// The only config: ESLint 10 looks for eslint.config.* from each file's folder up, so one placed in
// a subfolder would replace this one for everything below it.
export default defineConfig(
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/coverage/**",
    "**/cdk.out/**",
    "apps/web/out/**",
    "apps/web/out-*/**",
    "apps/web/next-env.d.ts",
    "apps/web/test-results/**",
    "apps/web/playwright-report/**",
    "packages/db/src/generated/**",
    "shopify-app/**",
    // Session worktrees are whole copies of the repo inside the main checkout, each with its own
    // eslint.config.mjs. (.claude/*.mjs, the committed demo servers, are still linted.)
    ".claude/worktrees/**",
    // Scripts kept for the record that run inside Figma, not here: the body of a plugin call
    // (a `figma` global, a top-level `return`). docs/ux-redesign/figma/README.md says what each is.
    "docs/ux-redesign/figma/**",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // `_name` marks a value that is deliberately unused (a destructured field left out, a
      // callback's position argument).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // `let { a, b } = ...` where only one of them is reassigned later is fine.
      "prefer-const": ["error", { destructuring: "all" }],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Code that runs in the browser gets zod from packages/shared/src/zod.ts, which turns off zod's
    // `new Function` probe there (the site's CSP reports it on every page).
    files: ["packages/shared/src/**/*.ts", "apps/web/**/*.{ts,tsx}"],
    ignores: ["packages/shared/src/zod.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "zod", message: "Import { z } from packages/shared/src/zod.ts: it keeps zod's eval probe out of the browser (CSP)." }] },
      ],
    },
  },
  {
    // Node scripts and configs (ESM .mjs, CommonJS .cjs).
    files: ["**/*.{mjs,cjs,js}"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", fetch: "readonly", AbortSignal: "readonly", __dirname: "readonly", require: "readonly", module: "writable" },
    },
  },
  {
    // bizinsights' Zapier app (integrations/zapier, docs/zapier.md): CommonJS, as Zapier's CLI runs it,
    // tested with Node's own runner (node:test). Outside the pnpm workspace: its own npm install, and no type check here.
    files: ["integrations/zapier/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { URLSearchParams: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
