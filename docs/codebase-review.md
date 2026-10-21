# Codebase structure review

## Implemented

1. Preserved the workspace boundaries: web, API, jobs, Cloudflare entry point, core, database and shared logic.
2. Moved dashboard reporting queries and assembly from the HTTP route into `packages/core/src/reports/dashboard.ts`. Permissions, validation, transactions and refresh scheduling remain in the API.
3. Removed four copies of cursor page shaping and limit parsing from WhatsApp routes. Shared pagination now prevents fractional limits from reaching Prisma.
4. Standardized 20 dashboard and WhatsApp component filenames to PascalCase and updated their imports. Recorded case-only renames for Linux deployments.
5. Normalized interrupted response-body reads and malformed error envelopes through ApiError; added regression coverage.
6. Centralized public frontend environment reads in `apps/web/src/lib/config.ts`. Existing validated Worker config remains the source for server settings.
7. Separated frontend HTTP transport, formatting and React data hooks. Kept compatibility exports so callers retain existing behavior.
8. Retained existing state ownership: request-scoped server-data hooks, AppContext for workspace/session selection, URL filters, local form drafts. No additional state dependency was required.
9. Updated architecture documentation with module entry points and outstanding debt.
10. Established a reusable report entry point independent of Hono while preserving existing API paths and response shapes.

## Verification

- All workspace type checks passed.
- Production frontend build passed: 39 static pages generated.
- Shared and core unit suites passed: 217 tests, including pagination and API transport regression cases.
- API integration tests could not initialize: test Postgres on localhost:5434 refused connections. Docker Desktop's engine was also unavailable.
- Browser end-to-end tests were not run.
- Worker type checking regenerated `apps/cloudflare/worker-configuration.d.ts` from the current local configuration.

## Remaining work

This is a structural improvement, not a certification of every code path. No repository-wide dead-code deletion was attempted without proof that exports are unused.

- Move WhatsApp campaign and automation orchestration from large route modules into core services.
- Extract remaining dashboard grading rules into pure domain helpers with focused behavior tests.
- Consolidate repeated dashboard presentation helpers when their semantics match.
- Assess whether the Meta ads and WhatsApp Graph clients can share transport utilities without losing their different authentication and retry behavior.
- Split the extracted report into smaller feature modules as reporting features evolve.
- Run database integration and browser suites after the local test stack is available.

Existing unrelated work was retained. No deployment or database migration was performed.
