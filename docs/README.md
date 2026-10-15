# Documentation

Where to find what, by question. Every page describes the code as it is; if one disagrees with
the code, the code wins and the page is the bug.

## Start here

| I want to... | Read |
| --- | --- |
| Understand how the system fits together | [architecture.md](architecture.md) (layers, where code goes, conventions), [architecture/dependency-map.md](architecture/dependency-map.md) |
| Run it on my machine | [local-dev.md](local-dev.md) |
| Add a feature, endpoint, table, job or integration | [development/adding-a-feature.md](development/adding-a-feature.md) |
| Know the coding and naming rules | [architecture.md](architecture.md#naming) and `pnpm lint` |
| Run or write tests | [architecture.md](architecture.md#tests), [local-dev.md](local-dev.md#tests) |
| Call the API | [api/api-overview.md](api/api-overview.md) |
| Change the database | [database/schema.md](database/schema.md), [database/migrations.md](database/migrations.md) |
| Deploy | [deployment-cloudflare.md](deployment-cloudflare.md) |
| Fix something in production | [RUNBOOK.md](RUNBOOK.md) |
| Know the security model | [security.md](security.md), [security-audit-2026-10-10.md](security-audit-2026-10-10.md) |

## Architecture records

| Page | What it holds |
| --- | --- |
| [architecture/current-state.md](architecture/current-state.md) | Audit of 2026-10-14: stack, structure, findings by severity |
| [architecture/target-architecture.md](architecture/target-architecture.md) | Where the structure is heading, and what is left to get there |
| [architecture/refactoring-plan.md](architecture/refactoring-plan.md) | The staged restructuring, and what was deliberately not done |
| [architecture/refactoring-report.md](architecture/refactoring-report.md) | What the restructuring changed, test results, open risks |
| [architecture/architecture-decisions.md](architecture/architecture-decisions.md) | Decisions and why (no API versioning, no store library, ...) |

## Product areas and integrations

| Area | Page |
| --- | --- |
| Shopify app, scopes, installs, billing | [shopify-setup.md](shopify-setup.md), [test-store.md](test-store.md), [webhooks.md](webhooks.md) |
| Sign-in (Amazon Cognito: email and password, Google, Apple; moving accounts from Firebase) | [cognito-setup.md](cognito-setup.md) |
| The AWS Phase 1 (staging) environment: Lambda, RDS, Cognito | [aws-staging.md](aws-staging.md) |
| Dashboard numbers | [kpis.md](kpis.md) |
| Meta Ads, Google Ads, AdSense | [ads-setup.md](ads-setup.md), [ads-review-packs.md](ads-review-packs.md) |
| WhatsApp | [whatsapp.md](whatsapp.md) |
