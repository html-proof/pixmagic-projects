// Lint for every workspace: `pnpm lint` (CI runs it). Type errors are TypeScript's job
// (`pnpm typecheck`); this catches what the compiler doesn't: hooks used wrongly or with stale
// dependencies, unused code, `any`, and the usual JavaScript pitfalls.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.wrangler/**",
      "**/coverage/**",
      "**/cdk.out/**",
      "apps/web/out/**",
      "apps/web/out-*/**",
      "apps/web/next-env.d.ts",
      "apps/web/test-results/**",
      "apps/web/playwright-report/**",
      "apps/cloudflare/worker-configuration.d.ts",
      "packages/db/src/generated/**",
      "shopify-app/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
    // Node scripts and configs (ESM .mjs, CommonJS .cjs).
    files: ["**/*.{mjs,cjs,js}"],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly", setTimeout: "readonly", clearTimeout: "readonly", fetch: "readonly", __dirname: "readonly", require: "readonly", module: "writable" },
    },
  },
);
