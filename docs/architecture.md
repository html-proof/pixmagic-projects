# Architecture and conventions

How the code is organised, where new code goes, and the conventions it follows. For running it see
[local-dev.md](local-dev.md); for production see [aws-deployment.md](aws-deployment.md) (AWS, where
every merge to `main` deploys) and [RUNBOOK.md](RUNBOOK.md).

## The shape of the system

The application code runs on AWS (`apps/aws`, `infra/cdk`) and, for development, the demos and
e2e, as one local Node process (`apps/aws/src/local.ts`). A third entry, `apps/aws/src/selfhost.ts`,
runs it on a server of its own (web and worker processes, PostgreSQL for the queue, schedules and
coordinator; `infra/ikorex`, docs/ikorex-migration), built for the move off AWS and not yet live.
Only the thin entry that wires it to its surroundings differs.

```
                        AWS                                   local server
browser ──► CloudFront + WAF ──► Lambda "api"           or  Node HTTP server
              /api/*, /webhooks/*, /pixel/*, /shopify/*  ──► Hono app (apps/api)
              everything else                            ──► static UI (apps/web, Next.js static export)
                                                             (if the function can't answer: apps/web's /unavailable page, from S3)

jobs   SQS (sync, webhooks, aggregate, email, whatsapp) ──► Lambda "jobs"   or  in-process queues ──► consume()       (apps/worker)
cron   EventBridge Scheduler (*/15, 03:15)    ──► Lambda "cron"   or  POST /__scheduled ──► runScheduled()  (apps/worker)

apps/api and apps/worker ──► packages/core (Shopify, Meta, Google, WhatsApp, email, staff, persistence)
                         ──► packages/db   (Prisma; RDS PostgreSQL on AWS, a local Postgres in development)
everything               ──► packages/shared (pure logic, no I/O)
```

Platform services sit behind interfaces in `Deps`, so the code never names a vendor: the
coordinator (`Coord`: rate limits, OAuth state, locks) is DynamoDB on AWS and memory locally; large
webhook bodies (`Blobs`) are S3 or memory; mail (`Mailer`) is SES or Mailpit; queues (`Queues`) are
SQS or in-process.

Database connections are process-wide pools (`DATABASE_URL`, `APP_DATABASE_URL`); `withDb()`
(packages/db) runs a call on connections of its own, which tests use to simulate an outage. The two
Prisma clients are built once per process (building one costs ~25 ms of CPU) and run each statement
on the current scope's connections, batching queries only within one scope (`scopedAdapter`,
`scopedQueues`).

## Packages: what goes where

Each package may import only the ones above it in this table, never one below.

| Package | Holds | Must not |
| --- | --- | --- |
| `packages/shared` | Pure functions and constants: KPI formulas, dates, roles and permissions, HMAC/AES, WhatsApp template rules, Zod schemas shared by API and UI, the staff pay/time engine (`@app/shared/staff`), email addresses as the app's own mail checks, normalizes and masks them (`@app/shared/email`), the Google Ads demo's generator and the Google Ads analytics figures (`adsDemo.ts`, `adsAnalytics.ts`). Browser-safe subpath exports (`@app/shared/roles`, `/dates`, `/whatsapp`, `/staff`, `/email`, ...). | Do I/O, read env, import Prisma. The UI imports subpaths only: the root barrel pulls `node:crypto` into the browser. |
| `packages/db` | Prisma schema, migrations (with RLS policies), `systemDb` / `tenantDb` / `withTenant` / `withDb`. | Contain business rules. |
| `packages/core` | Everything that talks to the database or an outside API on the app's behalf: Shopify client and sync (the GraphQL documents in `shopifyQueries.ts`), token encryption and key rotation (`keyRotation.ts`), normalizers, persistence and aggregates, alerts and audit, ad platforms (`ads/`: one client per platform, and `googleAdsSource.ts`, the source a Google Ads connection reads from: Google's API, or the generator behind the Google Ads demo, [ads-demo.md](ads-demo.md); `adConnections/`: connected accounts, their tokens, sync and reports, `demo.ts` the demo connection), WhatsApp, the Inventory module (`inventory/`: stock levels and locations, alerts, stock changes, its reports; docs/inventory.md), Zapier (`zapier/`, imported as `@app/core/zapier`: bizinsights as the OAuth provider of its Zapier app, the event outbox and its deliveries; [zapier.md](zapier.md)), the store's own costs (`expenses.ts`: Profit & Loss, Settings → Costs and the dashboard's `expenses` module, the recurring costs' payments recorded by the cron sweep; the rules, net profit included, in `@app/shared/expenses`; [kpis.md](kpis.md) "Costs and net profit"). Every Meta Graph API call, ads and WhatsApp alike, goes through `metaGraph.ts` (token in the Authorization header, paging links only to graph.facebook.com). The config schema (`env.ts`) and logger. | Know about HTTP requests or queues' delivery mechanics. |
| `apps/api` | HTTP: routing, auth, permission checks, input validation, response shapes. | Hold business logic that a job or another route could need: put it in core. |
| `apps/worker` | Queue consumers and cron sweeps (`src/handlers/`: one module per job, re-exported by `handlers.ts`): retries, backoff, failure bookkeeping, then a call into core. `ops/` holds one-off maintenance tasks (RUNBOOK.md). | |
| `apps/aws` | The Lambda entry (one build, three functions: api, jobs, cron; plus `cognitoEmail.ts`, its own small entry in the same package for the Cognito pool's email trigger): loads secrets at cold start, wires DynamoDB, SQS, S3 and SES into `Deps`, serves the UI and the API on one origin, gives every outbound call its timeout (`withTimeout`), runs migrations on request. The app's shared settings (`settings.ts`) and the local server (`local.ts`, `dev.ts`, `localQueues.ts`), which wires the same app to in-process stand-ins. | Contain logic beyond that wiring. |
| `infra/cdk` | The AWS infrastructure as code (edge, data, app, auth, WhatsApp and CI stacks) and the deploy, data-copy, smoke-test and rollback scripts. | Hold application code. |
| `infra/ikorex` | The self-hosted deployment (docs/ikorex-migration): Compose files, the app and PostgreSQL images, backups, monitoring, `ship.sh` / `deploy.sh`, env templates (never real values). | Hold application code or secrets. |
| `apps/web` | The UI (see [Frontend](#frontend-appsweb)). Depends on `@app/shared` only; talks to the API over HTTP. | Import core/db, or compute KPIs the API already returns. |

Where a new piece of code goes:

- A calculation, rule or label used by both the API and the UI → `packages/shared`.
- Anything that reads or writes the database or calls Shopify/Meta/Google → `packages/core`, as a
  function the route or job calls.
- A new endpoint → a route in `apps/api/src/routes/` that validates, authorizes and calls core.
- Work that may take longer than a request, must retry, or runs on a schedule → a queue job or a
  sweep in `apps/worker`, calling core.
- A screen → a page in `apps/web/src/app/`, built from components in `apps/web/src/components/`.

## API conventions (`apps/api`)

- **Routes** are grouped by area in `src/routes/<area>.ts`, each exporting `<area>Routes(app, deps)`,
  registered in `src/app.ts`. `deps` (`context.ts`) carries everything with side effects (auth
  provider, queues, coordinator, mailer, fetch), so tests substitute fakes.
- **Auth and tenancy**: `requireUser(c, deps)` for the signed-in user; `requireWorkspace(c, deps,
  ws, need)` for anything in a workspace. `need` is a workspace permission (`@app/shared/roles`) or
  one or more Team & Access permissions (`@app/shared/access`); owners and admins hold all of the
  latter, other members only what was granted to them ([team-access.md](team-access.md)). The UI asks
  `allowed(need)` (`useApp()`) for the same thing to decide what to show; `can(role, …)` is for owner
  and admin rights only and is false for every other role.
- **Reads** go through `withTenant(workspaceId, tx => ...)` (Postgres RLS as a second guard);
  `systemDb` is for auth bootstrap, webhooks, jobs and writes that already scoped by workspace and
  store. RLS binds it too, in the row scope its entry point names (`forTenant` for every
  `/workspaces/:ws` route and each job; `crossTenant(reason)` only for a reason on the list in
  `packages/db/src/crossTenant.ts`): [system-database-role.md](system-database-role.md). A new path
  outside `/workspaces/:ws` goes in `apps/api/src/rowScope.ts`; a new job kind, in
  `apps/worker/src/rowScope.ts`.
- **Input**: `z.object(...).parse(await body(c))` for JSON, the same for `c.req.query()`. A Zod
  failure becomes a 400 `validation` response automatically.
- **Errors**: throw `HttpError(status, message, code)` for anything the client should be told; the
  response is always `{ "error": code, "message": text }`. Core signals a rule the person broke, or
  a step they must take first, with a subclass of `AppError` (`StaffError`, `EmailError`,
  `WhatsappError`, ...): it carries its status and code, and `onError` answers it as is, so a route
  doesn't catch and re-throw it. Anything else reaches `onError`, which logs it and answers a
  generic 500. Map other known errors (e.g. `StoreDisconnectedError`, `AdsAuthError`) to an
  `HttpError` explicitly; never forward a raw `err.message`: it can carry database or provider
  internals. A provider's own reason (Meta, Google) may be shown only through `providerDetail()`.
  Machine endpoints (Shopify/Meta webhooks, the pixel) may answer `{ "error": code }` only.
- **Rate limits**: `limit(deps.coord, key, LIMITS.x)` from `rateLimit.ts`; a global per-IP limit
  runs as middleware.
- **Audit**: user-visible changes to a workspace call `audit()` (core) after the change.
- **Alerts**: `raiseAlert()` (core) for something a person must fix, resolved by whatever fixes it
  (`resolveAlerts`). Its message goes to the logs only: the bell in the top bar
  (`GET /workspaces/:ws/alerts`) and the admins' alert email (`alertEmail`) word each alert from its
  code and link to the page that fixes it (`describeAlert`, `ALERT_PATH` in `@app/shared/alerts`), so
  a new code needs its wording there. The Slack post carries the code and the alert's id, which
  finds the "alert raised" log line with the message.

## Integration status

Where every connection of a store stands is worked out once, on the server:
`GET /workspaces/:ws/stores/:storeId/integrations` (`routes/integrations.ts`) answers each module
(Shopify, Meta Ads, Google Ads, AdSense, WhatsApp) on one scale of six statuses:
connected, pending, reauthorization_required, syncing, error, disconnected. The scale, each
provider's states mapped onto it, and the ad cards' own states (`connectionState`, `platformState`,
which `apps/web/src/lib/adConnections.ts` re-exports) are pure functions in
`@app/shared/integrations`; core's `integrations/status.ts` composes what each module already says
about itself (the store's status and `syncProblem`, the ad rows and waiting sign-ins,
`waConnectionView`) and decides nothing again. A new
provider adds its mapping in shared and its module in core, and no page needs logic of its own.
Zapier isn't one of its modules: its Settings card reads `GET …/zapier`
([zapier.md](zapier.md#settings--integrations)). Every caller is told the same statuses. The
answer's shape, the mappings and who is offered which action: [api/api-overview.md](api/api-overview.md#integration-status).

Meta has a second answer of its own, `GET /workspaces/:ws/stores/:storeId/meta/discovery` (core's
`integrations/metaDiscovery.ts`, `@app/shared/metaDiscovery`): Meta found through the store's
Shopify connection, on six states from NOT_CONNECTED to AUTHORIZED_FOR_OUR_APP, from bizinsights'
own Meta sign-ins and the store's orders from Facebook and Instagram. Shopify never shares its Meta
access with an app, so Meta seen only in Shopify is never "connected":
[meta-discovery.md](meta-discovery.md).

## Worker conventions (`apps/worker`)

- A queue message is processed by `consume()`; a job that throws is retried with backoff up to
  `MAX_ATTEMPTS` (the SQS queues' `maxReceiveCount` in infra/cdk stays above it), then recorded as failed
  and alerted. A failure while Postgres is unreachable spends no attempts (`deferForDb`).
- Handlers must be idempotent: Shopify and SQS both deliver at least once.
- What Shopify, Meta and Evolution API send (webhook payloads, GraphQL pages, bulk JSONL, the
  WhatsApp webhooks) is checked once where it enters, against Zod schemas: `core/shopifyPayloads.ts`
  (`parseShopify`, `parseShopifyList` for a page), `core/whatsapp/webhook.ts` (Evolution API's
  deliveries) and `core/whatsapp/cloud.ts` (Meta's, for Cloud API numbers).
  What doesn't fit is logged (field paths, never values) and skipped, not thrown: a retry would only
  meet the same payload again. WhatsApp Automation reads an order or checkout only
  once it is about to act on it, so a store that doesn't use it logs nothing about it. The
  exception is the GDPR topics: a `customers/redact` or `customers/data_request` that can't be read
  fails at once (`UnrecoverableError`: recorded as failed and alerted), never marked as done.
- Each cron sweep runs on its own: one that throws is logged and the rest of the tick still runs.
- `UnrecoverableError` ends retries at once (revoked access, a store that is gone).

## Frontend (`apps/web`)

```
src/app/            routes (App Router). (app)/ is the signed-in shell: AppProvider + AppShell (top bar, sidebar).
                    portal/ (employee self-service) and join/ (employee invitations) sit outside it:
                    employees aren't workspace members. Staff Management: docs/staff.md.
src/components/     UI. dashboard/, funnel/, whatsapp/, email/, staff/, team/, landing/ per area; app-wide pieces at
                    the top (AppUi.tsx: page header, skeleton, toasts, useAction, confirm dialog; ui.tsx:
                    Alert, EmptyState, AuthShell). A page with several tabs or sections keeps only
                    their routing and state; the tabs and sections are components in
                    components/<area>/<page>/, a file each (staff/employee/, staff/timesheets/,
                    staff/settings/) or one file for small read-only ones (staff/payroll/).
src/hooks/          animation hooks for the landing page.
src/lib/            non-UI modules: the API client and hooks, sign-in (auth.ts: every call to /api/auth), storage, types of
                    API responses shared by several pages.
```

**Data and state.** There is no global store library, and none is needed: the server is the source
of truth and almost every screen is "load, show, edit, save".

| State | Where it lives |
| --- | --- |
| Server data | `useApi(path)` (`lib/api.ts`): each answer is kept with the request it answers, transient failures retry by themselves, `reload()` and `setData()` for edits. `useLiveApi(path, ms)` for data that must stay live (the dashboard). |
| Session, workspaces, current workspace and store | `AppContext` (`useApp()`), signed-in pages only. |
| The dashboard's date range, its comparison and open detail | The URL (`?preset=&from=&to=`, `?compare=&cfrom=&cto=`, `?view=`), so a link reproduces the view. The Advertising area (/advertising, [advertising.md](advertising.md)) reads the same dates and adds `?platform=&account=`; the Shopping Funnel (/funnel, [kpis.md](kpis.md) "Shopping Funnel page") adds `?device=&visitor=&landing=&country=`; Profit & Loss (/profit, [kpis.md](kpis.md) "Profit & Loss page") `?tab=&grain=`, and for its day-by-day sheet `?days=&events=`. |
| Per-device preferences (which Home, which menu and its open groups, the narrowed sidebar, the look around answered) | `lib/storage.ts` (`readLocal` / `writeLocal`): never throws, so blocked storage only loses the preference. |
| Form drafts | Component state. |

Write a hand-made `api()` call in an effect only when `useApi` can't express it (paging with
"load more", a request fired by a button), and then guard against late answers: keep the answer
with the request it belongs to, or ignore any response that isn't the latest (see
`components/dashboard/Contacts.tsx` and the audience count in `components/whatsapp/Campaigns.tsx`).

The API response reader (`lib/apiResponse.ts`) owns `ApiError`, body parsing and error-envelope
normalization. It has no React dependency, so response failures can be tested independently.
`lib/api.ts` re-exports the same error class and retains session, access-change and retry behavior.

**Loading and errors.** While loading: `Skeleton`. When a load fails: `LoadError` (says what failed,
treats an outage calmly, offers Try again), including when a *second* load on the page fails. A
failed action (save, delete): `actionError(e, "what you tried")` in a toast or an `Alert`. A crash
while rendering is caught by `app/(app)/error.tsx` inside the shell, or `app/error.tsx` for public
pages. Unknown paths get `app/not-found.tsx`.

**The signed-in look (the owner's Stitch design, 2026-11-06).** Every signed-in page follows the
approved Stitch prototypes (docs/kpis.md "The Sales pages"), through the shared pieces rather than
page by page:
- `globals.css` tokens: a cool off-white page, navy ink, slate secondary text, cool hairlines and a
  faint shadow.
- `card`: white, 8px radius, no outline. A card that sets a border colour (a highlighted one) or is
  dashed keeps that border.
- `btn` has a 4px radius; `btn-secondary` is a soft tinted button with no outline.
- `PageHeader` is a page's 32px title (`page-title`) on the page itself, not in a panel; a title
  inside the panel that heads its page is `card-title`.
- Section menus are a pale green row with green words.
- `AppShell` (`app-look`) sets the type in Inter, bundled from `@fontsource-variable/inter`: plain
  `@font-face`, so nothing is preloaded.
- `components/PageKit.tsx` holds the pieces a rebuilt page's layout is made of: `Card` (a white
  card with its heading), `FigureTile` and `ChangeTag` (a page's few numbers), `InShortLine` (the
  opening sentence), `ShareRow` (a labelled share bar), `PageTabs` (a row of tabs) and `HelpTip`
  (the small "i" beside a figure's name: what it measures, on hover, focus or tap).

A new page uses these pieces rather than its own borders and radii.

**Finding your way (2026-11-11).** Every page keeps its name, its address and its place in the menu's
whole list; what changed is how much of the list is read at once.
- **The short menu** (`SIMPLE_MENU` in lib/features.ts; the rules, tested, in `lib/menu.ts`; drawn by
  `AppShell.tsx`). The sidebar lists the everyday pages (Dashboard, Sales & Orders, Products,
  Customers, Inventory or Stock, Advertising, Profit & Loss) and folds the rest into four groups:
  More reports (Business Overview, Discounts, Shopping Funnel), Store (Orders,
  Shipping, Sales channels, Staff, My work), Marketing (the whole list's "Marketing & integrations")
  and Settings. A group opens
  with a click and stays open on that device (localStorage `menu-open`); the group holding the
  page being looked at is open by itself. A group of one page is shown as that page, and a menu of
  fewer than ten entries (a member shown a few pages, a shared dashboard) doesn't fold at all. "Show
  every page" at the foot brings back the whole list as it always was (`menu-layout`), and "Show
  fewer pages" returns. A new entry goes into the whole list and into the everyday list or one of
  the groups, both in `Sidebar`.
- **The narrowed sidebar** (wide screens): the button beside the logo narrows it to its icons
  (`menu-rail`), each named on hover and to screen readers; a group is one icon, which widens the
  sidebar with that group open.
- **The look around** (`components/Tour.tsx`, steps and card placement in `lib/tour.ts`): a few
  steps over the page itself, each lighting up one part (what needs you, the numbers, the dates,
  the menu, search, the bell, help) by its `data-tour` name. It is only ever offered: the simple
  Home shows one row on a device that hasn't answered (`tour-seen`), and the help button keeps
  "Show me around". Skip or Escape leaves at any step; a step whose part isn't on the page is left
  out. A new part of the frame worth pointing at gets a `data-tour` name and a step.
- **What a figure measures** (`components/dashboard/figureHelp.ts`): one wording per headline figure,
  behind its `HelpTip` on the Home's four numbers and the Sales Overview's, from the definitions in
  [kpis.md](kpis.md). A figure with a name a merchant may not know gets a `help` there.

**The Sales pages (Stitch screens 05–12).** The dashboard's topics (`?view=sales`, `products`,
`customers`, `orders`, `shipping`, `channels`, `discounts`, `timing`, `overview`) are pages of their
own, not panels over the Home: `components/dashboard/SalesFrame.tsx` draws the frame (title, the
store's status as a pill, the date chip, Download and Print, the breadcrumb back to Home) and the
row of tabs, Overview · Products · Customers · Orders & shipping · Visitors · Ads · Profit & Loss.
The last three tabs are the pages they always were (/funnel, /advertising, /profit); the first two
put `SalesTabs` above their own header, and Profit & Loss (which took the Profit sheet in on
2026-11-13, [kpis.md](kpis.md) "Profit & Loss page") draws its own sections' tabs instead. A tab is
shown to whoever the menu shows its page to, and moving between tabs keeps the dates. The tabs' layouts are in
`components/dashboard/SalesViews.tsx` (each from the same overview answer the Home reads); the
panels with more detail, and the topics that share the Overview tab, stay in `Details.tsx`. Every
menu entry still opens its own page.

**The Settings pages (Stitch screens 30–35).** The settings menu and its pages are unchanged; what is
on each follows the design: Integrations is screen 30's Connections, a card per connection two to a
row (Shopify, Meta Ads, Google Ads, AdSense, WhatsApp, Zapier), each with its own state
and the same on the one scale of six (`data-status`, [Integration status](#integration-status)).
Each keeps its own answers and wording (`IntegrationRow.tsx`, `AdRow.tsx`, `ZapierCard.tsx`).
Workspace and Costs are screen 31's Business details (the time zone and currency locked, as Shopify
gives them), Team & Access is screen 32, Notifications 33, Profile and Security 34, Privacy requests
and Audit log 35; Shopify, Advertising, Billing and API keys take the same look. Each page's title is
on the page (`page-title`), its panels are white `home-card`s with `home-h2` headings, and its
tables have the soft header row of the Sales pages.

**The Staff pages (Stitch screens 25–29).** The Staff section keeps its menu and its pages; what is
on them follows the Team screens. /staff is screen 25 ("Today"): Needs you, this week's hours and
wages, who's in (a row of counts), who is clocked in now, and today's shifts on one timeline
(`components/staff/overview/Today.tsx`, from the live board and that day's schedule), then the
shortcuts and this month's figures. All employees is screen 26 (a row per person with initials,
status and account, beside "How staff join"); Shift schedules is screen 27's week planner (a column
a day, totals per person and per day); Payroll and a pay run are screen 28 (what bizinsights does
and doesn't do with pay, the run as one figure "estimated, before tax" beside "Before you can
approve", Record payment per person). The other pages take the same look from the shared pieces in
`components/staff/ui.tsx`: statuses as tinted pills (`Pill`), figures as PageKit's `FigureTile`
(`KpiCard`), tables with a soft header row, tabs with a green underline. The employee portal is
screen 29: the organization and who is signed in at the top, one big Clock in, and the sections as
a bar of icons along the bottom of a phone; it sets the same Inter type (`app-look`) as the app.

**The Marketing pages (Stitch screens 14–20).** WhatsApp Automation's pages keep their routes and
section menu; what is on each page follows the design, through
`components/whatsapp/MarketingKit.tsx` on top of PageKit: tables with a tinted head row
(`TableCard`, `TableHead`, `Th`, `TD`, `ROW`), a channel's chip (`Chip`), the line of a page's few
facts (`FactsLine`), numbered form parts (`StepCard`), and a channel's card with one status word
and its facts (`ChannelPanel`, `FactList`). The setup and the builders are screen 19 (numbered
steps), the message history is 17, campaigns are 15, WhatsApp customers are 16, and WhatsApp setup
and settings are 18. Every figure is the page's own API answer; what the design shows and no API
returns (a total reach per channel, a "Pause all" across channels) is left out. The design's other
Marketing screens were for the Automations hub (screen 14), Customer Messaging (SMS) and Email
integrations, which were removed from the app on 2026-11-13.

**Fonts and prefetch.** Signed-in pages are in Inter (above). Only the landing page, the split-card
auth pages (`AuthSplitShell`) and the legal pages (`LegalPage`: /support, /privacy, /terms,
/data-deletion) are in Geist. Prefetching one of
those routes makes the current page preload Geist and its stylesheet, and Chrome then warns that they
were "preloaded but not used", and warns again a few seconds after every later request while they
stay unused. So a link from any other page to one of them is `<Link prefetch={false}>`. Geist Mono is
the landing page's alone: each font has its own CSS chunk (`cssChunking` in next.config.ts), so the
sign-in and legal pages' links to `/` (header and footer) are `prefetch={false}` too. The build fails
if a page preloads a font its markup doesn't use (scripts/check-font-preloads.mjs), and
e2e/console.spec.ts fails on any unused preload, CSP report or console error on the signed-in,
sign-in and legal pages.

**A clean console.** Chrome logs every response of 400 or more as a console error, so a state the
page expects is not an error response. Who is signed in comes from `getMe()` (lib/apiClient.ts):
GET /auth/whoami answers a visitor with `user: null` and a 200, where /me would answer 401 on every
app page a signed-out visitor opens. A refusal (a wrong code, a cancelled sign-in, an expired link)
stays a 4xx.

**Business logic.** Pages and components format and arrange what the API returns; rules and
calculations belong in `@app/shared` (shared with the API) or the API itself. The dashboard's
health grading lives in `@app/shared/health` and its drop-off and landing-page maths in
`@app/shared/journey` (the Shopping Funnel page's transitions, segments, tests and observations in
`@app/shared/funnel`); the repeated sentence pieces are in `components/dashboard/Narrative.tsx`.
When a page needs to know what the API will allow (what a template draft breaks), it asks the same
function the API uses (`waTemplateIssues` in `@app/shared/whatsapp`) rather than writing the rule
out again.
A topic's page loads its panels on demand (`components/dashboard/Details.tsx`, a `dynamic` import in
the dashboard page): keep code that only a click needs out of the page's first load.

**Landing page motion.** On integrated graphics the page drops frames on GPU work, not JavaScript,
so every effect has to be cheap for the GPU process. Many laptops also refresh at 120–144 Hz, which
leaves 7–8 ms per frame:

- Nothing may make the browser scroll on the main thread: no `background-attachment: fixed` (the
  app-wide washes sit on a fixed `body::before` layer instead) and no non-passive wheel or touch
  listeners. A fixed background made every scroll frame repaint the whole window.
- Anything whose transform or opacity follows the scroll gets its own layer (`lp-layer`), so the
  GPU moves it instead of the browser repainting the area around it. Avoid animating `filter`,
  `backdrop-filter`, `mask-image`, `border-radius`, `clip-path` or colours on large elements:
  each frame of those is a repaint. No `backdrop-filter` on the fixed nav: what scrolls under it
  changes on every frame, so it was re-blurred on every frame.
- Particles go through `components/landing/shared/particles.ts`: one batched WebGL draw per frame
  (2D fallback included), set up in idle time after the intro. Don't stamp hundreds of shapes with
  the 2D canvas API. `hooks/useCanvasLoop.ts` draws at most every 9.5 ms (every other frame on a
  120–144 Hz screen); hide a canvas layer while it has nothing on it.
- Ambient loops are composited CSS animations (`lp-loop`, paused off screen by `usePauseWhenHidden`),
  one animation per moving element: while the page draws frames for anything else, Chrome updates
  the style of every running animation on each of them. No SVG `stroke-dashoffset`/SMIL loops, no
  `offset-path` (it runs on the main thread: sample the path into transform keyframes, as
  `HeroFlows` does) and no motion `repeat: Infinity` (it runs in JavaScript on every frame).
- Wheel scrolling is eased by `hooks/useSmoothScroll.ts` (Lenis) on 60 Hz-class screens only; faster
  screens keep the browser's own smooth scrolling, which doesn't wait for the main thread. Either
  way scroll-driven scenes follow the scroll directly: don't add `useSpring` on top of scroll progress.

## Configuration

| Setting | Lives in | Read by |
| --- | --- | --- |
| App settings (public: app ids, API versions, scopes, flags) | `apps/aws/src/settings.ts` (shipped in the functions' package, put in `process.env` at cold start by `apps/aws/src/index.ts`; not in the 4 KB environment); locally overridden by `apps/aws/.env` | `env()` in `packages/core/src/env.ts` |
| Secrets (session, encryption keys, client secrets) | Secrets Manager `insights/production/*`, set with `infra/cdk/scripts/put-secrets.mjs` ([aws-deployment.md](aws-deployment.md)); locally `apps/aws/.env` (from `.env.example`) | `apps/aws/src/secrets.ts` at cold start, into `process.env`, then `env()` |
| Services (queues, coordinator, payload store, mail) | infra/cdk (queue URLs, table, bucket, SES region in the functions' environment) | `apps/aws/src/index.ts` (AWS) or `local.ts` (local), passed as `Deps` |
| Sign-in (Amazon Cognito: pool, client, domain; the client secret) | the Auth stack (`infra/aws/cognito.yaml` via infra/cdk), into the runtime parameter and a secret ([cognito-setup.md](cognito-setup.md)) | `cognitoConfig()` in `apps/api/src/cognito.ts` |
| AWS settings (URLs, ids, flags) and infrastructure choices | SSM parameter `/insights/production/runtime`; CDK context (`infra/cdk/lib/config.ts`, `cdk.json`, the deploy workflow's `-c` flags) | `apps/aws` at cold start; `infra/cdk` at deploy |
| Feature flags for unfinished work | `apps/web/src/lib/features.ts` | the UI |
| Local tooling (docker compose, Prisma CLI, `ops:*` tasks) | repo-root `.env` (from `.env.example`) | those tools only |

`env()` validates the whole app config with Zod on first use and, in production, refuses to
start with a secret still set to a value published in this repository, or with a development
setting that turns a safeguard off (the Auth emulator, a Mailpit relay, a local `APP_URL`). New
settings go into its schema with a default (or as required), then into `apps/aws/src/settings.ts`
(or, for a secret, `put-secrets.mjs`) and `apps/aws/.env.example`. A new provider with a public id
and a secret also adds that pair to `providerCredentials` in `packages/core/src/configReport.ts`,
so the deploy's config check warns when the id is set and the secret isn't (and a shape for the
secret to `put-secrets.mjs`, if it has a recognisable one). Code reads settings through
`env()`, not `process.env`. The exceptions are deliberate: the logger (`LOG_LEVEL`), the database
connections (`DATABASE_URL` / `APP_DATABASE_URL`), per-app Shopify secrets whose names are dynamic
(`SHOPIFY_APP_SECRET_<KEY>`), and `apps/aws`, which puts the secrets into `process.env` at cold start
and reads the Lambda's own settings (queue URLs, bucket, table, region) before `env()` can run.

Local tools and the local server use the `app_dev` database; production's `app` is only ever reached
by pointing `DATABASE_URL` at it on purpose ([ADR-008](architecture/architecture-decisions.md#adr-008-defaults-that-can-only-reach-production-on-purpose)).

## Naming

- **Files**: React component files are PascalCase (`StoreHeader.tsx`, `LoadError.tsx`, and modules of
  several components such as `WaUi.tsx`, `Primitives.tsx`); modules of helpers, hooks,
  constants or types are camelCase (`format.ts`, `storage.ts`, `heroLayout.ts`). `ui.tsx` (app-wide
  and in `components/staff`, `components/landing/shared`) is the one fixed name. Rename a file as a
  commit of pure `git mv` renames, imports in the next commit: git carries other branches' edits
  across a pure rename; a rename mixed with edits turns them into conflicts.
- **Exports**: components and helpers are named exports; only Next.js pages, layouts and boundaries
  use default exports.
- **Errors**: `XxxError extends Error` (or `AppError`, for a rule the person broke) and sets
  `this.name`, so logs say which.
- **API**: route files by area (`routes/staffPayroll.ts`), registration functions `<area>Routes`.
- **Relative imports inside packages** use the `.js` extension (`./dates.js`), except in the
  `packages/shared` modules the UI imports by subpath (`ads.ts`, `sales.ts`): Next's bundler does
  not map `./dates.js` to `dates.ts` in a workspace package, so those stay extensionless.

## Tests

| Kind | Where | Runs with |
| --- | --- | --- |
| Unit (pure logic, config files, AWS adapters, the local server) | `packages/shared/test`, `packages/core/test`, `apps/aws/test`, `apps/web/test` (`node --test`) | `pnpm test` |
| Infrastructure (synthesized stacks) | `infra/cdk/test` | `pnpm --filter @infra/cdk test` |
| Integration (real Postgres, faked Cognito/Shopify/Meta) | `apps/api/test`, `apps/worker/test` | `pnpm test:integration` (database `*_test`; `TEST_PG_PORT` points it at a throwaway server) |
| End to end (Playwright against the local server) | `apps/web/e2e` | `pnpm e2e` |
| Lint (TypeScript, React hooks) and import cycles | everywhere | `pnpm lint` (CI fails on any finding; `scripts/check-import-cycles.mjs` fails on any module that imports itself through others, `import()` included) |

A bug fix comes with the test that would have caught it. CI also checks the dependency audit, that
the migrations produce exactly `schema.prisma`, and that the Lambda package builds.

A release's migrations are applied before its code goes live ([aws-deployment.md](aws-deployment.md),
"Migrations before the switch"), so the release before keeps running on them for up to a minute of
every deploy: a migration adds, never drops or renames what the previous release reads, and a new
NOT NULL column has a default (drops take two releases).

## Known structural debt

### Frontend transport and recovery

`lib/api.ts` remains the compatibility entry point. HTTP transport, shared-tab session selection,
permission signals and `ApiError` now live in `lib/apiClient.ts`; React data hooks and polling live
in `hooks/useApi.ts`; number formatting lives in `lib/format.ts`. Both entry points use the same
error class. Transport changes must retain auth challenge data, access-fingerprint notifications,
and suppression of late shared-session sign-outs. Public customer links omit credentials and
never change merchant permissions or session state.

`ErrorState`, `ErrorNotice` and `PublicLinkError` provide recovery views; the last keeps customers
on the store's public link. Every error card (the 404 page, crashes, failed loads, customer links) is
`ErrorPanel` in `components/ErrorState.tsx`: the status code in the logo's green, or an illustration
for a failure without one, and a `fullPage` one sits in the site's frame (`ErrorPage`), so a new error
screen uses it rather than a design of its own. The access screens (access revoked or ended, a shared
dashboard closed: `components/team/AccessStates.tsx`) use it too, with a word in place of a code.
`app/unavailable` is the page CloudFront shows at any page's address while the server can't answer;
the AWS build moves it to the site bucket, so it must work without the API (no API calls; support is
a mail link). Retry-After hints disable manual retries and delay automatic retries.
Use `pnpm --filter @app/web test` for transport and recovery tests and
`pnpm --filter @app/web test:errors-ui` for browser checks independent of Postgres and Cognito.

`pnpm check:boundaries` enforces package dependencies in the seven source trees, including the
current AWS entry point. It checks static imports, re-exports and literal dynamic imports or
require calls; computed imports are outside its scope. Frontend code must use browser-safe
shared subpaths rather than the server barrel. Existing state ownership and the shared health
grading API remain unchanged.

The planned moves are all done (below, by date); what is left needs a decision or a pass of its own,
for the reason given on each item. (Done in the 2026-10-14 restructuring:
dashboard reporting moved to `packages/core/src/reports/`, one cursor-paging helper, dashboard
helpers and grading rules de-duplicated, dashboard component files renamed;
[architecture/refactoring-report.md](architecture/refactoring-report.md). Done 2026-10-16: the
WhatsApp campaign, automation and cart-reminder rules moved from `routes/whatsappOps.ts` into core,
`AppError` for rule violations, provider text only through `providerDetail()`, the remaining file
renames, app-wide UI out of `components/whatsapp`, dead code removed, and Zod schemas at the
Shopify and Meta boundaries (`core/shopifyPayloads.ts`, `core/whatsapp/metaPayloads.ts`) instead
of `any` in every payload reader: the normalizers, the WhatsApp and email automations, Meta's
WhatsApp webhooks, the app and GDPR topics, and the worker's order detail pages and bulk JSONL;
no `any` is left in the hand-written source. Done 2026-10-18
([architecture/initial-audit.md](architecture/initial-audit.md)): one Meta Graph transport,
`core/ads.ts` and `core/whatsapp/events.ts` split by platform and by event, the import-cycle
check, and the staff employee, timesheets and settings pages and the Team page split into
components; then `worker/handlers.ts` (one module per job in `worker/src/handlers/`),
`core/adConnections.ts` (`core/adConnections/`), Shopify's GraphQL documents out of
`core/normalize.ts` (`core/shopifyQueries.ts`), the pay run page's sections
(`components/staff/payroll/`) and the sales chart (`components/dashboard/ColumnsWithTotal.tsx`).)

What is left is not a move:

- `noUncheckedIndexedAccess` in `apps/web` (437 findings, nearly all in landing animations): a pass
  with visual checks.
- No formatter (Prettier) or import sorting: one repository-wide reformat, at a moment when no
  branch is open, as a commit of its own.
