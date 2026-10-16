# Team & Access

Who can open a workspace's dashboard, and what of it they see. Owners and admins manage it from
**Team & Access** in the sidebar (`/team`; the old Settings → Members & roles redirects there).

## The model

| Piece | Where |
| --- | --- |
| Permission catalog, role templates, `allows()`, the dashboard redaction | `packages/shared/src/access.ts` (`@app/shared/access`) |
| Invitations, acceptance, access changes, revoke/restore/remove, retention | `packages/core/src/team/` |
| Every request's check (`requireWorkspace(c, deps, ws, need)`) | `apps/api/src/context.ts` |
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

## Invitations

- A random 256-bit token; only its SHA-256 is stored. The link is `/invite#token=…`: the fragment
  never reaches a server, so the token stays out of CloudFront and API logs. Links sent before
  (`?token=`) still work.
- Accepted once (one conditional update claims it), must first be opened before it expires (1–30
  days, 7 by default), replaced when the same address is invited again, rotated on resend.
- **The link is the way in** (`POST /invitations/open`, called as soon as `/invite` loads): no
  account, sign-up or password. The browser gets a *shared-link session* (`session.ts`
  `newLinkSession`, `m: "link"`, `ws: <workspace>`) that opens that workspace only:
  - `requireUser` refuses it (403 `shared_link`) unless the route passes `{ shared: true }`:
    `GET /me` (which then lists that workspace only and returns `shared`), whoami, and the
    workspace checks `requireWorkspace` / `requireStaff`, which answer 404 for any other workspace.
    `loadUser` treats it as signed out elsewhere (OAuth callbacks, Shopify installs).
  - So a forwarded link exposes no more than the invitation did: never the person's own account
    (profile, password, sessions), their other workspaces, or connecting stores.
  - No Cognito identity behind it. The membership is checked on every request, as for anyone.
  - Someone new gets a user record with no sign-in of its own. Signing up later with that address
    (verified) links to it (`identity.ts`).
- After the first opening the link keeps opening the dashboard (another device, a session that
  ended) for `LINK_REOPEN_DAYS` (60), while the member's access lasts: revoking or removing them ends
  it at once. Signed in already as the invited person, it just joins in their own session. Signed in
  as someone else, the page says who and offers to open it as the invited person (`switch`: that
  browser is signed out of the other account). Only from our own pages (login CSRF). Opening on
  arrival is safe with email scanners because the link isn't used up.
- The web app (`Me.shared`) hides the account's own pages (profile, sign-in and security), shows
  "Opened from your invitation link" on the member badge, and offers "Sign in to your account".
- The optional message is plain text, at most 500 characters, without links (every invitation is an
  email from our domain).
- If the email can't be sent, the invitation is kept and the inviter gets the link to pass on.

## Live updates

Every workspace response carries `x-access-fp: <workspace>:<fingerprint>`. The web app reloads the
member's permissions as soon as a response shows a different fingerprint or a request is refused,
and checks `GET /workspaces/:ws/access` every 5 seconds while the tab is visible (answered `304`
while nothing changed). WebSockets or server-sent events would need new infrastructure (the API's
Lambda Function URL buffers responses); enforcement never depends on the browser noticing.

## Audit and retention

`member.invited`, `member.invitation_resent`, `member.invitation_updated`, `member.invitation_revoked`,
`member.joined`, `member.access_changed` (with previous and updated access, added and removed
permissions), `member.access_revoked`, `member.access_restored`, `member.removed`, `report.exported`.
The worker's daily sweep (`pruneTeamRecords`) deletes invitations 90 days after they ended and
`member.*` audit entries after two years.

## Existing members

Migration `20261016180000_team_access` gave existing analysts and viewers (and their pending
invitations) everything they could see before, as permissions (`LEGACY_GRANTS`), so nobody gained or
lost access when this shipped.
