# Structure review — 21 October 2026

The repository already separates frontend, HTTP handlers, background jobs, runtime wiring,
database access, core services and pure shared logic. Keep these boundaries rather than moving
files purely for appearance. `architecture.md` documents their responsibilities, naming,
configuration, error handling and state ownership.

## Changes in this pass

- Extracted trend, refund, stock and shipping grading rules from dashboard UI into the browser-safe
  `@app/shared/health` module. Removed the duplicate shipping threshold from the shipping card.
- Decoupled preview health types from the overview React component.
- Added threshold tests, including incomplete days and invalid numeric comparisons.
- Added `pnpm check:boundaries` to detect forbidden package imports across all seven source trees.
  The check uses the installed TypeScript parser and needs no new dependency.

## Existing mechanisms retained

- HTTP errors are normalized centrally by Hono; the browser has a separate API transport.
- Worker settings are validated in core; public frontend configuration has a dedicated module.
- Server state uses request-scoped hooks, workspace/session state uses AppContext, shareable filters
  use the URL, and form drafts stay local. A second global store is not currently justified.
- API endpoints are grouped by feature, use injected dependencies, authorize tenant access, and
  call reusable core services. Existing endpoint paths remain unchanged.

## Limits and remaining work

This pass does not certify every code path or claim all ten broad goals are finished. Active
uncommitted error-handling work existed before this review and continued changing during it;
those edits were preserved. No unproven dead-code deletions were made.

- WhatsApp HTTP modules still contain orchestration that can move to core services.
- Dashboard explanations and previews retain additional derived rules; extract them by feature.
- Large report modules can be split as their independent contracts become clear.
- Existing core API-transport tests expect old error messages and currently fail against the
  active frontend error changes. The frontend test loader also failed while resolving a hook
  as `.tsx`; investigate those alongside the active error-handling work.

## Verification

- Boundary check passed across seven source trees.
- Frontend TypeScript check passed.
- Production frontend build passed, generating all 39 static pages; export prefetch fix completed.
- Shared suite: 121 tests passed, including four new health-rule tests.
- Core suite: 96 passed, four failed on existing API error message expectations.
- Database integration and browser suites were not run in this pass.
- The available `pnpm` launcher selects a different version inside nested scripts and attempts
  dependency reinstallation. Verification used installed TypeScript and Vitest entry points
  directly, avoiding changes to the dependency tree.
