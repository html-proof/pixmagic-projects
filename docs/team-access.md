# Team & Access

Who can open a workspace's dashboard, and what of it they see. Owners and admins manage it from
**Team & Access** in the sidebar (`/team`; the old Settings → Members & roles redirects there).

## The model

| Piece | Where |
| --- | --- |
| Permission catalog, role templates, `allows()`, the dashboard redaction | `packages/shared/src/access.ts` (`@app/shared/access`) |
| Invitations, acceptance, access changes, revoke/restore/remove, renew, links, history, retention | `packages/core/src/team/` |
| Invitation email and its delivery records (provider-agnostic: Resend, SES) | `packages/core/src/mail/`, `packages/core/src/team/email.ts` |
| Every request's check (`requireWorkspace(c, deps, ws, need)`), which session a request uses (`pickSession`) | `apps/api/src/context.ts` |
| The mail provider's delivery events (signed) | `apps/api/src/routes/mailEvents.ts` |
| Team API | `apps/api/src/routes/team.ts` (the old member endpoints in `workspaces.ts` call the same core functions) |
| Web: pages a member may open, topic rules, live refresh | `apps/web/src/lib/access.ts`, `components/AppContext.tsx` |
| Team page, invite and edit panels | `apps/web/src/app/(app)/team/page.tsx`, `components/team/` |
| Invitation page | `apps/web/src/app/invite/page.tsx` |

- **Owners and admins** hold every permission. **Managers, analysts, viewers and custom members**
  hold exactly the permissions stored on their membership (`memberships.permissions`); the role is
  only the template those were picked from. Viewers and analysts can't hold anything that changes
  data; managers and custom members can be given "Manage integrations" and "Manage staff".
- Sensitive permissions (customers' names and contact details, stock value, finance, payroll,
  managing integrations or staff, exports) are never in a template and "Select all" leaves them out:
  they are ticked one by one.
- A permission never gets round Shopify: the dashboard's modules still need the store's scopes
  (`capabilities.ts`). The invite panel marks permissions whose data no connected store has granted.
- A restricted role's `can(role, …)` (roles.ts) is always false, so a check that forgets the grants
  fails closed. Ask `allows(access, need)`.

## What the API enforces

- **Deny by default, route by route** (`apps/api/test/routeAccess.test.ts`): every route the API
  serves is called as nobody signed in (401), as a member given nothing (403/404, except their own
  access, notification settings, the store picker and a dashboard answer with no modules), as
  another business's owner (404), as this workspace's owner naming another business's store (never
  its data, never a call to Shopify for it), and as a shared link and an API key (every change
  refused). A route that isn't public, an account's own or a workspace's fails the test until it is
  placed in one of its lists, so a new route can't become reachable by accident.
- Every route asks who is calling before it reads the request: a stranger gets 401 or 404, never a
  validation error that shows what the route expects.
- `requireWorkspace` reads the membership from the database on every request: a change or a
  revocation applies to the member's next request. A revoked member gets `403 access_revoked`.
- `GET …/overview` computes only the modules the member may see (`storeOverview(…, sees)`), then
  `redactOverview` removes fields that need their own permission (gross sales/discounts/tax/shipping
  and total sales, which holds tax and shipping, so such a member's headline is net sales; returns
  and refunds per day; the year report, stock value, order payment/fulfillment/cancellation, paid
  attribution, ad campaigns, discount amounts, import counts).
- `GET …/contacts` asks Shopify only for the lists the member may see and blanks names, contact
  details and order history per permission (`redactContact`).
- WhatsApp, ads, email, staff and settings routes each ask for the permission that covers them; the
  Shopify store itself (connect, resync, disconnect), members, API keys, billing and the audit log
  stay with owners and admins.
- `GET …/export?section=` (CSV) needs "Export approved reports" plus the section's own permission,
  and holds only what the member sees. Customer lists are never exported.
- Workspace API keys see what viewers saw before Team & Access (`LEGACY_GRANTS.viewer`), read-only.
- Connecting the store to Zapier ([zapier.md](zapier.md)) needs "Manage integrations" and the
  member's own sign-in. The connection acts as that member: every Zapier request and every event
  sent re-checks their membership, and each trigger also needs its data permission ("View advertising
  analytics", "View campaigns", the bell's rule for alerts). Removing the member revokes it.
- The Inventory pages (`apps/web/src/app/(app)/inventory`, API `routes/inventory.ts`) have a module
  of their own: view, product information, costs and stock value, stock history, export, adjust
  stock, stock alerts, inventory settings (docs/inventory.md). Costs are left out of every answer
  and CSV without `inventory.costs`; changing stock needs `inventory.adjust`, which a shared link
  never has. Existing members get none of them until an owner or admin ticks them; the viewer,
  analyst and manager templates start with view and product information.

## Invitations

- A random 256-bit token (CSPRNG). It is looked up by its SHA-256; the token itself is kept only
  encrypted with the app's keyring (AES-256-GCM, bound to the invitation's id), so an owner can copy
  the same link again ("Copy link") without breaking the one already sent, and a copy of the
  database alone opens nothing. The link is `/invite#token=…`: the fragment never reaches a server,
  so the token stays out of CloudFront and API logs, and the invite page moves it out of the
  address bar (into the tab's sessionStorage) before any other script runs, so analytics and the
  browser history never see it. The page sends no Referer. Links sent before (`?token=`) still work.
- **Lifetime**: the link, and the access it gives, last 60 days by default (7, 14, 30 or 60), counted
  from the invitation; the membership gets the same end date (`memberships.access_expires_at`).
  After it, every request answers `403 access_expired` and the link stops opening the dashboard,
  until an owner or admin **renews** it (60 more days from then; the same link works again).
  Members from before this have no end date and keep none.
- **Resend** sends the same link again (renewing an expired, unopened invitation). **Replace link**
  gives a new one and the old one stops opening the dashboard at once (tabs already open carry on
  until access is revoked). Inviting the same address again replaces an invitation not yet opened.
- **The link is the way in** (`POST /invitations/open`, called as soon as `/invite` loads): no
  account, sign-up or password. The browser gets a *shared-link session* (`session.ts`
  `newLinkSession`, `m: "link"`, `ws: <workspace>`) in a cookie of its own, `__share` (httpOnly,
  Secure, SameSite=Lax), ending with the link. It never replaces or touches an account's `__session`
  on the same browser: a tab showing a shared dashboard sends `x-bi-context: shared` (per tab,
  sessionStorage) and its requests use `__share` only; every other tab uses the account's session
  (or `__share` when no account is signed in there). The two are never merged (`pickSession`).
  - A 401 answers for the session the call was made as. Closing a shared dashboard
    (`leaveSharedSession` in lib/api.ts) signs the shared-link session out while the dashboard's
    checks may still be in flight as it; `api` notes which session each call used and, unless
    that is still the tab's session and the tab is not leaving it (`signedOutHere`), marks the
    refusal `sessionLeft` instead of treating the tab as signed out, so the tab goes to the
    homepage, not to sign in or to "This shared dashboard has closed".
  - **View-only**: a link session holds the member's view and export permissions only, never a
    "manage" one, and an owner's or admin's link is a viewer of everything (`linkSessionAccess`,
    `readOnlyStaffAccess`). Managing the team, stores, billing, integrations or staff always needs
    the person's own sign-in.
  - It is a bearer credential: anyone holding the link can open that view-only dashboard until it
    ends. It goes only to the invited address; the team list shows when and how often it was opened
    ("Access history" has each opening with its IP), and an owner can replace or revoke it.
  - `requireUser` refuses it (403 `shared_link`) unless the route passes `{ shared: true }`:
    `GET /me` (which then lists that workspace only and returns `shared`), whoami, and the
    workspace checks `requireWorkspace` / `requireStaff`, which answer 404 for any other workspace.
    `loadUser` treats it as signed out elsewhere (OAuth callbacks, Shopify installs).
  - So a forwarded link exposes no more than the invitation did: never the person's own account
    (profile, password, sessions), their other workspaces, or connecting stores.
  - No Cognito identity behind it. The membership is checked on every request, as for anyone.
  - Someone new gets a user record with no sign-in of its own. Signing up later with that address
    (verified) links to it (`identity.ts`).
  - **An address that already has an account someone signs in to is never joined by the link
    alone** (409 `sign_in_required`; `account_unverified` while nobody has proved its address):
    whoever holds a link may not be its person (an owner or admin can always copy it), and opening
    it would otherwise make that account a member of their workspace without them. The invite page
    accepts at once if this browser is signed in to that account (`POST /invitations/accept`: the
    invited, verified address), and otherwise offers "Sign in to accept" and comes back to the
    invitation (the token waits in the tab's sessionStorage, never in the address bar or
    localStorage). After that, the link reopens their view-only shared dashboard like anyone's.
  - Onboarding connects a store into the workspace named by `?ws=`, otherwise only into one the
    person owns (the selected one, else their first), and makes them one of their own when they
    own none: never into another business's workspace just because an invitation put them in it.
- After the first opening the link keeps opening the dashboard (another device, a session that
  ended) until its end date, while the member's access lasts: revoking or removing them ends it at
  once. Removing them also cancels it for good (`revoked_at`), so inviting them back later never
  revives an old link. Signed in already to an account (theirs or anyone's), the account stays signed in and
  untouched in its own tabs. Only from our own pages (login CSRF). Opening on arrival is safe with
  email scanners because the link isn't used up (a scanner that runs scripts counts as an opening).
- The web app (`Me.shared`) hides the account's own pages (profile, sign-in and security), shows
  "Opened from your invitation link" on the member badge, and offers "Sign in to your account".
- The optional message is plain text, at most 500 characters, without links (every invitation is an
  email from our domain).
- If the email can't be sent, the invitation is kept and the inviter gets the link to pass on.
- **An owner or admin who is removed, revoked, or no longer an owner or admin takes no working link
  along** (`retireLinksOf`, in the same transaction as the change): the invitations they sent that
  nobody accepted are cancelled, and every other invitation whose link they had (sent, copied,
  resent or replaced, from the audit log) gets a new link, so the old one stops working (dashboards
  already open carry on while the access lasts; an owner copies the new link from the team list).
  Their own invitation keeps its link while they stay a member. The counts go into the change's
  audit entry (`invitationsCancelled`, `linksReplaced`, and `ownLinksEnded` on removal).

## Email delivery

`core/mail`: one provider interface (`Mailer.send` returns the provider's receipt; failures are a
`MailError` that says *transient*, *not_allowed* or *permanent*). Each invitation email is a row in
`email_deliveries`; the team list shows its latest status: **Email queued** (retrying), **sent**
(the provider accepted it; never "delivered"), **delivered**, **delayed**, **bounced**, **marked as
spam**, **failed**, **not sent** (the provider won't send to this address from our account yet:
SES's sandbox). Delivered/bounced/complained come only from the provider's signed webhook
(`POST /webhooks/email/resend`, Svix signature, 5-minute replay window); opens and clicks are not
tracked. No address or message content is kept in the delivery records or the logs. Which provider
sends is configuration (docs/aws-deployment.md "App email"); in production it is Resend since
2026-10-16, so invitations reach any address.

## What the web app does

The pages are static files with no data in them: everything a page shows comes from the API above,
which decides. `canOpenPage` (`apps/web/src/lib/access.ts`) says which pages a member may open, by
path; the route guard (`useAccessGuard`, `components/AppShell.tsx`) sends anyone on a page they may
not open (typed in, bookmarked, or just taken away) to where they can go, saying "You don't have
access to that page.", before the page mounts, so it never asks for its data. The sidebar, the
command palette and the section menus (Settings) list only pages `canOpenPage` allows; WhatsApp
Automation is one page whose tabs follow what its API answer allows (Customers only with "View contact
information"). An
address with no page at all (`/dashboard/setting`) is the not-found page, outside the app.
`apps/web/e2e/team.spec.ts` types the owners' and admins' pages into a shared dashboard and calls
their APIs from it.

## Live updates

Every workspace response carries `x-access-fp: <workspace>:<fingerprint>` (for a link session, the
fingerprint of its view-only access). The web app reloads the member's permissions as soon as a
response shows a different fingerprint or a request is refused, and checks
`GET /workspaces/:ws/access` every 5 seconds while the tab is visible (answered `304` while nothing
changed). WebSockets or server-sent events would need new infrastructure (the API's Lambda Function
URL buffers responses); enforcement never depends on the browser noticing: every request is checked
against the database, so a removed permission, a revocation or an end date applies to the very next
request on every device. Nothing per member is cached server-side.

## Audit and retention

`member.invited`, `member.invitation_resent`, `member.invitation_updated`, `member.invitation_revoked`,
`member.invitation_renewed`, `member.invitation_link_copied`, `member.invitation_link_replaced`,
`member.link_opened` (with the IP), `member.access_renewed`, `member.joined`, `member.access_changed` (with previous and updated access, added and removed
permissions), `member.access_revoked`, `member.access_restored`, `member.removed`, `report.exported`.
The worker's daily sweep (`pruneTeamRecords`) deletes invitations 90 days after they ended and
`member.*` audit entries after two years.

## Existing members

Migration `20261016180000_team_access` gave existing analysts and viewers (and their pending
invitations) everything they could see before, as permissions (`LEGACY_GRANTS`), so nobody gained or
lost access when this shipped.
