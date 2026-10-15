# API overview

The JSON API the web app uses, served by the same Lambda function as the UI. Behind it: `apps/api`
(Hono). How to add an endpoint: [../development/adding-a-feature.md](../development/adding-a-feature.md).

## Addressing

- Browser and UI: `https://<host>/api/<path>`. Webhooks, the pixel, Shopify's callbacks and the
  health checks are also answered without the `/api` prefix (`/webhooks/*`, `/pixel/*`,
  `/shopify/*`, `/healthz`, `/readyz`), for URLs registered with providers.
- Not versioned: the UI ships with the API in one release
  ([ADR-003](../architecture/architecture-decisions.md#adr-003-no-apiv1-prefix)).

## Authentication and authorization

| Caller | How | Notes |
| --- | --- | --- |
| Signed-in user | `__session` cookie (our signed session, httpOnly, SameSite=Lax; `__session_rt` holds the encrypted Cognito refresh token, sent to `/api` only) | Mutations must come from the app's Origin (CSRF). Sign-in endpoints check Origin even without a cookie. |
| API key | `Authorization: Bearer sk_live_...` | Read-only (acts as `viewer`), one workspace. |
| Providers | Shopify HMAC, Meta `X-Hub-Signature-256`, OAuth state + PKCE | Verified before anything is read or written. |

Workspace routes check membership first (non-members get **404**, so ids can't be probed), then
the permission in the table below (`@app/shared/roles`):

| Permission | owner | admin | analyst | viewer / API key |
| --- | --- | --- | --- | --- |
| `dashboard:read` | ✓ | ✓ | ✓ | ✓ |
| `customers:contact` | ✓ | ✓ | ✓ | |
| `stores:manage`, `members:manage`, `apikeys:manage`, `audit:read` | ✓ | ✓ | | |
| `billing:manage`, `workspace:delete` | ✓ | | | |

(The matrix is the code's, `packages/shared/src/roles.ts`; check there when in doubt.)

## Responses

- **Success**: JSON objects; mutations answer `{ "ok": true, ... }` or the changed resource
  wrapped (`{ "campaign": {...} }`).
- **Errors**: `{ "error": "<code>", "message": "<text for people>" }` with the status that fits
  (400 `validation` / `invalid_range`, 401 `unauthenticated`, 403 `forbidden` / `csrf`, 404
  `not_found`, 409, 413, 429 `rate_limited`, 502 when a provider failed, 503 when the database or
  Cognito is unreachable, 500 `internal` for anything unexpected; the cause is only in the logs).
  Machine endpoints (webhooks, pixel) answer `{ "error": "<code>" }`.
- **Every response** carries `x-request-id` (a random UUID). Quote it when
  reporting a problem: every log line written for that request carries the same id.
- **Lists**: capped (100 by default). WhatsApp messages, orders, carts and reviews page with
  `?limit=&cursor=` and answer `{ <items>, nextCursor }` (`apps/api/src/pagination.ts`).
- **Rate limits**: 300 requests a minute per IP overall (AWS WAF at CloudFront, and the app behind
  it; webhooks and the pixel exempt), tighter per-key limits on sign-in,
  codes, invitations, provider calls and public pages (`apps/api/src/rateLimit.ts`).

## Health

| Path | Answers |
| --- | --- |
| `GET /healthz` | `{ "ok": true }` while the API runs (liveness). |
| `GET /readyz` | `{ "ok", "checks": { "db", "coord", "tenantDb" } }`, 503 when any is false; each probe is bounded (3 s) and a failure is logged with its reason. |

## Endpoints

Generated from the route files (`apps/api/src/routes/*.ts`); "Access" is the permission each
route checks, or how a public route is protected.

| Method | Path | Access | File |
| --- | --- | --- | --- |
Shopify HMAC of the raw body ||||||||||| GET | `/workspaces/:ws/stores/:storeId/ads` | dashboard:read | ads.ts |
| POST | `/workspaces/:ws/stores/:storeId/ads/:provider/connect` | stores:manage | ads.ts |
| GET | `/ads/:provider/callback` | public (signed/origin-checked) | ads.ts |
| GET | `/workspaces/:ws/stores/:storeId/ads/pending/:nonce` | stores:manage | ads.ts |
| POST | `/workspaces/:ws/stores/:storeId/ads/pending/:nonce` | stores:manage | ads.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/ads/pending/:nonce` | stores:manage | ads.ts |
| PATCH | `/workspaces/:ws/stores/:storeId/ads/connections/:id` | stores:manage | ads.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/ads/connections/:id` | stores:manage | ads.ts |
| GET | `/workspaces/:ws/stores/:storeId/ads/meta/report` | dashboard:read | ads.ts |
| GET | `/workspaces/:ws/stores/:storeId/ads/google/report` | dashboard:read | ads.ts |
| POST | `/workspaces/:ws/stores/:storeId/ads/sync` | stores:manage | ads.ts |
| POST | `/auth/session` | public (signed/origin-checked) | auth.ts |
| POST | `/auth/sync-profile` | signed in | auth.ts |
| POST | `/auth/logout` | public (signed/origin-checked) | auth.ts |
| GET | `/me` | signed in | auth.ts |
| GET | `/auth/whoami` | public | auth.ts |
| PATCH | `/me` | signed in | auth.ts |
| POST | `/auth/otp/request` | public (signed/origin-checked) | auth.ts |
| POST | `/auth/email-link/verify` | public (signed/origin-checked) | auth.ts |
| POST | `/auth/otp/verify` | public (signed/origin-checked) | auth.ts |
| GET | `/workspaces/:ws/stores/:storeId/contacts` | customers:contact | contacts.ts |
| GET | `/workspaces/:ws/stores` | dashboard:read | dashboard.ts |
| GET | `/workspaces/:ws/stores/:storeId/sync` | dashboard:read | dashboard.ts |
| GET | `/workspaces/:ws/stores/:storeId/overview` | dashboard:read | dashboard.ts |
| POST | `/pixel/:key` | per-store ingest key, rate-limited | pixel.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/request` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/refresh` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/revoke` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/shopify/install` | stores:manage | shopify.ts |
| POST | `/workspaces/:ws/shopify/start` | stores:manage | shopify.ts |
| GET | `/shopify/callback` | public (signed/origin-checked) | shopify.ts |
| GET | `/shopify/launch` | public (signed/origin-checked) | shopify.ts |
| POST | `/webhooks/shopify` | public (signed/origin-checked) | webhooks.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/embedded` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/manual/discover` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/manual` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/register` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/pin` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/refresh` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/settings` | dashboard:read | whatsapp.ts |
| PUT | `/workspaces/:ws/stores/:storeId/whatsapp/settings` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/templates` | dashboard:read | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/templates` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/test` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/analytics` | dashboard:read | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/messages` | customers:contact | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/messages/:id/retry` | stores:manage | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/messages/:id/cancel` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/orders` | customers:contact | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/orders/:id` | customers:contact | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/orders/:id/steps` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/carts` | customers:contact | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/carts/:id/remind` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/reviews` | customers:contact | whatsappOps.ts |
| PATCH | `/workspaces/:ws/stores/:storeId/whatsapp/reviews/:id` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns` | dashboard:read | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/estimate` | dashboard:read | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | dashboard:read | whatsappOps.ts |
| PATCH | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | stores:manage | whatsappOps.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | stores:manage | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id/schedule` | stores:manage | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id/pause|resume|cancel` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/automations` | dashboard:read | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/automations` | stores:manage | whatsappOps.ts |
| PATCH | `/workspaces/:ws/stores/:storeId/whatsapp/automations/:id` | stores:manage | whatsappOps.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/automations/:id` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/automations/:id/runs` | dashboard:read | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/automations/:id/test` | stores:manage | whatsappOps.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/contacts/summary` | dashboard:read | whatsappOps.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/contacts/opt-out` | customers:contact | whatsappOps.ts |
| GET | `/webhooks/whatsapp` | Meta verify token | whatsappPublic.ts |
| POST | `/webhooks/whatsapp` | `X-Hub-Signature-256` (rate-limited when not Insights' own app) | whatsappPublic.ts |
| GET | `/public/track/:token` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| GET | `/public/review/:token` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| POST | `/public/review/:token` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| GET | `/public/stores/:storeId/reviews` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| GET | `/r/:code` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| GET | `/whatsapp/platform` | public (unguessable token / rate-limited) | whatsappPublic.ts |
| POST | `/workspaces` | signed in | workspaces.ts |
| PATCH | `/workspaces/:ws` | members:manage | workspaces.ts |
| GET | `/workspaces/:ws/members` | dashboard:read | workspaces.ts |
| POST | `/workspaces/:ws/invitations` | members:manage | workspaces.ts |
| POST | `/invitations/accept` | signed in | workspaces.ts |
| PATCH | `/workspaces/:ws/members/:memberId` | members:manage | workspaces.ts |
| DELETE | `/workspaces/:ws/members/:memberId` | members:manage | workspaces.ts |
| POST | `/workspaces/:ws/stores/:storeId/resync` | stores:manage | workspaces.ts |
| DELETE | `/workspaces/:ws/stores/:storeId` | stores:manage | workspaces.ts |
| GET | `/workspaces/:ws/notifications` | dashboard:read | workspaces.ts |
| PUT | `/workspaces/:ws/notifications` | dashboard:read | workspaces.ts |
| GET | `/workspaces/:ws/api-keys` | apikeys:manage | workspaces.ts |
| POST | `/workspaces/:ws/api-keys` | apikeys:manage | workspaces.ts |
| DELETE | `/workspaces/:ws/api-keys/:keyId` | apikeys:manage | workspaces.ts |
| GET | `/workspaces/:ws/billing` | dashboard:read | workspaces.ts |
| POST | `/workspaces/:ws/billing/subscribe` | billing:manage | workspaces.ts |
| GET | `/workspaces/:ws/audit-logs` | audit:read | workspaces.ts |
| GET | `/workspaces/:ws/alerts` | dashboard:read | workspaces.ts |
