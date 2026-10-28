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
- **Lists**: capped (100 by default). WhatsApp messages and contacts page with `?limit=&cursor=`
  and answer `{ <items>, nextCursor }`.
- **Rate limits**: 300 requests a minute per IP overall (AWS WAF at CloudFront, and the app behind
  it; webhooks and the pixel exempt), tighter per-key limits on sign-in,
  codes, invitations, provider calls and public pages (`apps/api/src/rateLimit.ts`).

## Health

| Path | Answers |
| --- | --- |
| `GET /healthz` | `{ "ok": true }` while the API runs (liveness). |
| `GET /readyz` | `{ "ok", "checks": { "db", "coord", "tenantDb" } }`, 503 when any is false; each probe is bounded (3 s) and a failure is logged with its reason. |

## Integration status

`GET /workspaces/:ws/stores/:storeId/integrations` answers every connection of a store at once, its
status worked out on the server (`routes/integrations.ts`, core's `integrations/status.ts`,
`@app/shared/integrations`), so every page says the same thing and a new provider needs no logic of
a page's own. It needs **View integration connection status** (`integrations.status`): a member
without it gets 403, and another workspace's store, or a disconnected one, 404. It is read-only and
calls no provider: it composes what each module already says about itself.

```json
{ "modules": [{
  "id": "meta_ads", "title": "Meta Ads", "status": "reauthorization_required", "code": "auth_expired", "demo": false,
  "accounts": [{ "id": "…", "name": "Shop ads", "status": "reauthorization_required", "lastSyncedAt": "…", "lastAttemptAt": "…", "code": "auth_expired", "demo": false }],
  "lastSyncedAt": "2026-10-29T09:00:00.000Z",
  "capabilities": ["spend", "impressions", "reach", "frequency", "clicks", "linkClicks", "…"],
  "actions": ["connect", "reconnect", "refresh", "disconnect"],
  "href": "/settings/ads"
}] }
```

Modules, always all of them and in this order: `shopify`, `meta_ads`, `google_ads`, `adsense`,
`whatsapp`, `sms`, `email`. The Zapier app (PR #275) adds its module once it merges. The answer
doesn't leave out what an App Store workspace doesn't offer: the UI does (`lib/features.ts`).

| Status | Means |
| --- | --- |
| `connected` | It works: the numbers come in, or messages can go. |
| `pending` | Set up, and waiting for a step: the platform's approval or review, a first check, the store's first import, the rest of a channel's setup. |
| `reauthorization_required` | Someone must sign in again: the access ended, a permission was taken back, or the person whose login powered it left. |
| `syncing` | bizinsights is bringing it up to date, or checking it, now; it settles by itself. |
| `error` | Connected, and not working: the last attempt failed, or the platform stopped the account. |
| `disconnected` | Nothing connected (or disconnected, closed), or the provider isn't set up on this server (`code` `not_configured`). |

Where each provider's own states land:

- **Shopify** (`stores.status`): active → connected (without a token: reauthorization_required),
  pending → pending, syncing → syncing. A store in error by the dashboard's reason (`syncProblem`,
  the `code`): lost access (`access`) → reauthorization_required, Shopify's approval of protected
  customer data (`not_approved`) → pending, the rest (a frozen, closed or locked shop) → error.
- **Meta Ads, Google Ads, AdSense**: each account by the cards' own state (`connectionState`):
  synchronizing → syncing; reconnect required, authorization required, permission missing →
  reauthorization_required; verification pending → pending; sync failed → error; closed →
  disconnected. The module is the worst of the accounts shown on the dashboard (`platformState`). A
  sign-in still waiting for its ad accounts is connected, as its card says, with its reason as its
  `code`. The Google Ads demo is an account with `demo: true`, and the module says `demo` when every
  account it counts is the demo.
- **WhatsApp** (the connection as its page shows it, `waConnectionView`): connected; pairing →
  pending; reconnecting → syncing; logged out → reauthorization_required; failed → error;
  disconnected → disconnected, as is a phone once linked with a QR code (`qr_linking_retired`).
- **SMS** (the Automations hub's card): connected; needing attention → error when the check at AWS
  failed (`connection_failed`), pending while the store's setup is left (the first step as `code`);
  not connected → disconnected.
- **Email** (each mailbox's status): connected; pending (not tested yet) → pending; testing →
  syncing; degraded, failed → error; reauthorization_required; disabled, revoked → disconnected. The
  module: the hub's card when connected, else the worst mailbox still in use; with every mailbox
  working, pending (no verified sender yet, sending paused) or error (suspended by bizinsights).

`actions` are what this caller may press, by their permissions and the module's state; each is done
on the provider's own routes. A shared dashboard link and an API key get none.

| Module | Who | Actions |
| --- | --- | --- |
| Shopify | owners and admins (`stores:manage`) | `refresh` (active or in error), `reconnect` (lost access), `disconnect` |
| Ad platforms | Manage integrations | `connect` (set up on this server), `reconnect` (an account needs signing in again), `refresh` (a shown account with a working grant, the demo, or a waiting sign-in), `disconnect` |
| WhatsApp | Manage integrations; `refresh` ("Check now") View campaigns | `connect` (set up on this server, nothing connected), `reconnect` (logged out or failed), `refresh`, `disconnect` |
| SMS, email | the hub's own (`hubPermissions`: SMS owners and admins, email Manage integrations) | the hub card's, its test as `refresh` |

`capabilities` are fixed per module: the store's data modules (`CAPABILITIES`), each ad platform's
report figures, and the messaging channels' counts (WhatsApp sent, delivered, read, failed). Nothing
secret is in the answer: no token, no password, no full phone number (a number is masked, and the
SMS sender is never named by its AWS resource name).

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
| GET | `/workspaces/:ws/stores/:storeId/sales-calculation` | finance.breakdown | dashboard.ts |
| PUT | `/workspaces/:ws/stores/:storeId/sales-calculation` | stores:manage | dashboard.ts |
| GET | `/workspaces/:ws/stores/:storeId/integrations` | integrations.status | integrations.ts |
| POST | `/pixel/:key` | per-store ingest key, rate-limited | pixel.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/request` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/refresh` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/stores/:storeId/scopes/revoke` | stores:manage | scopes.ts |
| POST | `/workspaces/:ws/shopify/install` | stores:manage | shopify.ts |
| POST | `/workspaces/:ws/shopify/start` | stores:manage | shopify.ts |
| GET | `/shopify/callback` | public (signed/origin-checked) | shopify.ts |
| GET | `/shopify/launch` | public (signed/origin-checked) | shopify.ts |
| POST | `/webhooks/shopify` | public (signed/origin-checked) | webhooks.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp` | marketing.campaigns or integrations.status | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/connect/start` | integrations.manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/connect/finish` | integrations.manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/connect/numbers` | integrations.manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/connect/number` | integrations.manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/connect/pin` | integrations.manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/connect/check` | integrations.manage | whatsapp.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp` | integrations.manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/pin` | owners and admins | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/settings` | marketing.campaigns | whatsapp.ts |
| PUT | `/workspaces/:ws/stores/:storeId/whatsapp/settings` | stores:manage | whatsapp.ts |
| POST|DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/settings/event-key` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/templates` | marketing.campaigns | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/templates` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/templates/sync` | stores:manage | whatsapp.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/templates/:id` | stores:manage | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/templates/:id/test` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/messages` | marketing.campaigns (text: customers.contact) | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/messages/:id` | marketing.campaigns (text: customers.contact) | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/messages` | stores:manage + customers.contact | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/messages/:id/retry` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/contacts` | marketing.campaigns + customers.contact | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/contacts/:id` | marketing.campaigns + customers.contact | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/contacts/:id/consent` | stores:manage + customers.contact | whatsapp.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/events` | stores:manage | whatsapp.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/workflows` | marketing.campaigns | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/workflows/check` | marketing.campaigns | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/workflows` | stores:manage | whatsappAutomation.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/workflows/:id` | marketing.campaigns | whatsappAutomation.ts |
| PUT | `/workspaces/:ws/stores/:storeId/whatsapp/workflows/:id` | stores:manage | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/workflows/:id/activate|pause|test` | stores:manage | whatsappAutomation.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/workflows/:id` | stores:manage | whatsappAutomation.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns` | marketing.campaigns | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/estimate` | marketing.campaigns | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns` | stores:manage | whatsappAutomation.ts |
| GET | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | marketing.campaigns | whatsappAutomation.ts |
| PUT | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | stores:manage | whatsappAutomation.ts |
| DELETE | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id` | stores:manage | whatsappAutomation.ts |
| POST | `/workspaces/:ws/stores/:storeId/whatsapp/campaigns/:id/test|schedule|cancel` | stores:manage | whatsappAutomation.ts |
| GET | `/webhooks/whatsapp` | Meta verify token | whatsappWebhook.ts |
| POST | `/webhooks/whatsapp` | `X-Hub-Signature-256` (refusals rate-limited per IP) | whatsappWebhook.ts |
| POST | `/whatsapp/events` | the store's event key (`Authorization: Bearer whev_...`) | whatsappWebhook.ts |
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
