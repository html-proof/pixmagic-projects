# Staff Management, Time & Attendance and Payroll

Employees, invitations, clock-in/out with breaks, timesheets and corrections, shift schedules,
payroll runs with approvals, payment records, analytics and exports, and an employee
self-service portal. Built into the existing app: organizations are workspaces, sign-in is the
existing Firebase Authentication, data lives in the same Postgres behind the same RLS.

| Where | What |
| --- | --- |
| `packages/shared/src/staff/` | Pure rules shared by API and UI: money (integer minor units), time zones/DST, pay periods and report ranges, the overtime/pay engine, attendance flags and statuses, permissions, password policy. `@app/shared/staff`. |
| `packages/core/src/staff/` | Everything that reads or writes the database: employees, invitations, attendance, payroll, payments, analytics, reports and the CSV/XLSX/PDF writers. |
| `apps/api/src/routes/staff*.ts` | HTTP: validation (Zod), authorization (`staffAccess.ts`), rate limits, mapping to core. |
| `apps/worker/src/index.ts` | The */15 cron flags shifts left open too long and alerts owners/admins. |
| `apps/web/src/app/(app)/staff/` | Admin section (Overview … Settings). |
| `apps/web/src/app/portal/`, `apps/web/src/app/join/` | Employee portal and the invitation sign-up page. |
| `packages/db/prisma/migrations/20261014120000_staff_management/` | Tables, constraints, RLS, freeze triggers. |

## Installing

1. Apply the migration **before** deploying the code: `pnpm db:migrate` (production: `DATABASE_URL=<prod> pnpm --filter @app/db migrate:deploy`). It only adds tables, two nullable columns (`memberships.staff_role`, `invitations.staff_role`) and one enum, so the running version keeps working while it applies.
2. Deploy as usual (docs/deployment-cloudflare.md). No new secrets or bindings are needed: invitations use the existing mailer (`EMAIL_FROM` on a domain onboarded to Cloudflare Email Sending; locally Mailpit), accounts use the existing Firebase project.
3. In the app: **Staff → Settings** — set the organization's time zone, currency, pay cycle, week start, overtime and break policies, holidays. Give non-admin members a staff role in **Settings → Members & roles**.

Nothing else is required. What is *not* set up, and why, is under [Not included](#not-included).

## Roles

Owners and admins have every staff permission. Other members get one optional **staff role** on
top of their workspace role. Employees are not workspace members; they only reach their own
records through the portal.

| Permission | Owner / Admin | HR manager | Payroll manager | Supervisor |
| --- | --- | --- | --- | --- |
| See staff list (`staff:view`) | ✓ | ✓ | ✓ | assigned employees only |
| Add/edit/deactivate, invitations, schedules (`staff:manage`) | ✓ | ✓ | | |
| See pay rates, earnings, payroll, payments (`pay:view`) | ✓ | | ✓ | |
| Change pay rates and overtime/break policies (`pay:manage`) | ✓ | | ✓ | |
| Live attendance, timesheets (`attendance:view`) | ✓ | ✓ | ✓ | assigned only |
| Correct, approve, reject hours (`attendance:manage`) | ✓ | ✓ | ✓ | assigned only |
| Run payroll, adjustments (`payroll:manage`) | ✓ | | ✓ | |
| Approve / reverse payroll (`payroll:approve`) | ✓ | | ✓ | |
| Record / fail / reverse payments (`payments:manage`) | ✓ | | ✓ | |
| Exports (`staff:export`; pay exports also need `pay:view`) | ✓ | ✓ (attendance) | ✓ | |
| Organization settings, holidays (`staff:settings`) | ✓ | | | |

Enforced on every request by `requireStaff` / `requireEmployee` (`apps/api/src/staffAccess.ts`);
the UI asks the same matrix (`staffAccess` in `@app/shared/staff`) only to decide what to show.
Pay fields are left out of responses for people without `pay:view`. Unknown or foreign ids answer
404, never 403, so ids can't be probed. API keys never reach staff data.

## Onboarding and sign-in

1. **Add employee** (Staff → Add employee). The Employee ID (`EMP-0001`, unique per organization)
   is generated in the same transaction as the record.
2. **Send invitation** emails a link with a random 256-bit token; only its SHA-256 is stored. It
   expires after `invitation_expiry_hours` (default 48), works once, and sending a new one revokes
   the old one (one live invitation per employee is a database constraint). **Copy invitation
   link** hands the link to the admin instead.
3. The employee opens `/join?token=…`, sees their name, position and organization, and sets a
   password (twice). The API checks the password policy (12+ characters, three of four character
   types, not common, not their name or email), uses the invitation up atomically (two requests
   with one link: one wins), and creates the Firebase account with that password — Firebase stores
   a salted scrypt hash; Insights never stores or logs it.
4. **Email ownership.** An emailed link that was never shown to the admin proves the inbox, so the
   account starts verified and the portal opens at once. An account created from a *copied* link
   starts unverified and must click Firebase's verification email before the portal answers
   (`email_unverified`). If the address already has an account, the page asks them to sign in and
   joins that account instead (`/staff/invitations/accept-existing`).
5. Later sign-ins use the normal login (password, Google, email code); forgot password is the
   existing `/reset`. Logout ends this browser's session; **Sign out of all devices** (portal →
   Account) revokes every session of the account (`POST /auth/sessions/revoke`).
6. **Deactivate** stops clock-ins and the portal's actions immediately (checked on every request),
   closes any open shift at that moment (flagged for review) and revokes unused invitations.
   History stays for payroll; deactivated employees can still read their past pay.

## Time and attendance

- **Server time only.** Clock in/out and breaks record the server's timestamp in UTC. The device's
  clock and time zone are stored with the event for the audit trail and never used for pay. The
  portal's timer is drawn from the server's `clockInAt` and `serverTime`, so refreshes, other
  devices, a wrong device clock or a changed device time zone don't move it.
- **No double shifts.** Every clock action locks the employee row for its transaction, and partial
  unique indexes allow one open shift per employee and one open break per shift. Each action can
  carry an `Idempotency-Key`: a retry with the same key returns the first result.
- **Breaks.** Short (rest) and meal breaks; whether each kind is paid comes from the employee's
  break policy at the moment it starts. Policies can cap the number of breaks per shift (refused
  past the cap) and flag breaks longer than a limit.
- **Flags** are computed from the times: late start / left early (against the matched scheduled
  shift and the grace minutes), not on the schedule, overnight, holiday, long break, too many
  breaks, and "forgot to clock out?" (open longer than `stale_session_hours`, default 14). An open
  shift **stops adding paid time at that limit**; the cron flags it and alerts owners/admins; a
  manager sets the real clock-out time.
- **Corrections.** Employees can request a change or report a missed shift (if allowed); managers
  approve or reject. Managers can also correct directly or add a missed shift. Every change bumps
  the shift's `revision` and writes the before/after to `attendance_events`. Times may not overlap
  another shift of the same person.
- **Approvals.** Closed shifts are approved or rejected (with a reason). With "require approval"
  on (default), only approved hours are paid. Once an approved payroll includes a shift it is
  locked — the API refuses edits, and a database trigger refuses them too.

## How pay is calculated

All in `packages/shared/src/staff/payroll.ts` (unit-tested), the same code for the portal's
estimate, analytics, and the payroll run.

1. Paid time = clock-in to clock-out minus unpaid breaks, in whole seconds.
2. Time is cut at the **organization's local midnights** (DST-aware): a piece belongs to the day it
   was worked. Overnight shifts land on both days; a shift crossing a pay-period boundary is split
   between the periods.
3. In time order, per local day and per week (starting on the configured day): time past the
   daily threshold is overtime, past the double-time threshold double time, and regular time past
   the weekly threshold is overtime (daily overtime doesn't count again toward the weekly one).
   Thresholds and multipliers come from the employee's overtime policy; with none, all time is
   regular. On a public holiday with a premium, regular time is paid at the holiday multiplier
   and overtime at the higher of the two.
4. Each day uses the **rate in force that day** (`pay_rate_history`, effective-dated). A new rate
   can't start on a day an approved payroll already paid.
5. Amounts are integer minor units (bigint): seconds × rate × multiplier, rounded half away from
   zero **once per line** (category × rate × multiplier), so a payslip's lines add up exactly.
   Currencies keep their own precision (JPY 0, USD 2, KWD 3). No floating point touches money.

**Estimates.** Insights doesn't implement any jurisdiction's tax, social security, superannuation,
leave accrual or award/penalty rules. Gross pay follows the configured policies; "net" is gross plus
the earnings and minus the deductions an authorized person adds. Every screen and document says
so. The `jurisdiction` setting is a label only.

## Payroll

- **Periods** follow the pay cycle (daily, weekly, two-weekly from an anchor date, semi-monthly
  1–15/16–end, monthly) or any custom range up to 62 days. Live periods can't overlap (advisory lock
  + check, and a unique index per range), so no day is paid twice.
- **Draft → Waiting for approval → Approved → Partly paid / Paid**, plus Needs changes (sent back,
  or figures changed), Cancelled, Payment failed and Reversed.
- **Calculate** prices approved, closed shifts and adds adjustments; each calculation bumps the
  period's `version`. **Submit** recalculates and refuses while there are open shifts, unapproved
  hours, pending change requests, time with no pay rate, or negative net pay. **Approve** names the
  version reviewed, recalculates from the database and compares: if anything changed it is not
  approved and goes back to Needs changes. Approval locks the period and its shifts; a trigger then
  refuses any change to an item's figures.
- **Reverse** (approved, nothing paid) unlocks the shifts so the days can be run again.

## Payments

Recording a payment says money was paid outside Insights — **Insights moves no money** and has no
payment-provider integration. "Payment provider" is a method label for transfers made through
one. A payment needs approved payroll, an `Idempotency-Key` (one per form), and can't exceed the
item's outstanding balance (checked with the item row locked). The same amount on the same day
asks for confirmation; a transaction reference is unique per employee and method. Partial payments
are tracked per item; the period moves to Partly paid / Paid. Failed or reversed payments stop
counting. Receipt attachments are not implemented.

## Analytics and reports

- KPI cards (each with the previous comparable value, change, explanation and update time): total
  and active staff, working now, hours today/this week/this month, regular and overtime hours,
  payroll cost today/week/month/year, amount paid, still to pay, waiting for approval, average
  hourly rate. "This week/month/year" compare with the same elapsed part of the previous one;
  today compares with yesterday up to the same time.
- Ranges: Live, Today, Yesterday, This/Last week, This/Last month, This/Last year, Custom (up to
  ~3 years). Buckets: hour, day, week, month, quarter, year. All in the organization's time zone.
- Charts: working hours, payroll cost, cost per employee, regular vs overtime, attendance
  (present / absent = scheduled but didn't clock in / late), paid vs owed vs outstanding.
- Live attendance refreshes by polling every 10 s while the page is visible (the app's existing
  live-data mechanism, `useLiveApi`); the Workers deployment has no push channel for it.
- Reports (attendance, payroll, payments) group by employee, department, position, day, week,
  month, year, pay period, method or status, and export as **CSV** (UTF-8, formula-injection safe),
  **Excel (.xlsx)** and **PDF**; plus **PDF payslips** and **payment statements**. Downloads go
  through a one-time link valid for 5 minutes for the user who asked, re-authorized at download,
  generated from the database at that moment and never stored.

## API

All under `/api`. Admin routes need a signed-in, verified member with the permission shown in the
route file; employee routes need the employee's own verified account.

| Area | Routes |
| --- | --- |
| Config | `GET /workspaces/:ws/staff/access`, `GET …/staff/config`, `PUT …/staff/settings`, `POST/PATCH/DELETE …/staff/departments[/:id]`, `…/staff/overtime-policies[/:id]`, `…/staff/break-policies[/:id]`, `POST/DELETE …/staff/holidays[/:id]` |
| Employees | `GET/POST …/staff/employees`, `GET/PATCH …/staff/employees/:id`, `POST …/:id/deactivate`, `POST …/:id/reactivate`, `POST/DELETE …/:id/pay-rates[/:rateId]`, `GET …/:id/audit` |
| Invitations | `POST …/staff/employees/:id/invitations` `{delivery: email\|link}`, `POST …/invitations/revoke`, `GET …/staff/invitations`; public `GET /staff/invitations/lookup?token=`, `POST /staff/invitations/accept`, `POST /staff/invitations/accept-existing` |
| Schedules | `GET/POST …/staff/schedules`, `PUT/DELETE …/staff/schedules/:id` |
| Attendance | `GET …/staff/attendance/live`, `GET …/staff/timesheets`, `GET …/staff/timesheets/:id`, `POST …/timesheets/:id/corrections`, `POST …/employees/:id/shifts`, `POST …/timesheets/approve`, `POST …/timesheets/:id/approve\|reject\|reopen`, `GET …/staff/corrections`, `POST …/corrections/:id/approve\|reject` |
| Payroll | `GET/POST …/staff/payroll/periods`, `GET …/payroll/suggestions`, `GET …/periods/:id`, `POST …/periods/:id/calculate\|submit\|approve\|reject\|cancel\|reverse`, `POST/DELETE …/periods/:id/adjustments[/:adjustmentId]` |
| Payments | `GET/POST …/staff/payroll/payments` (POST needs `Idempotency-Key`), `GET …/payroll/payable`, `POST …/payments/:id/fail\|reverse` |
| Analytics | `GET …/staff/analytics`, `GET …/staff/analytics/trends`, `GET …/staff/reports`, `POST …/staff/exports`, `GET /staff/exports/:token` |
| Employee portal | `GET /employee/workspaces`, `GET /employee/:ws/dashboard`, `GET /employee/:ws/attendance/me`, `POST /employee/:ws/attendance/clock-in\|clock-out\|break/start\|break/end` (optional `Idempotency-Key`), `GET /employee/:ws/timesheets`, `POST /employee/:ws/corrections`, `GET /employee/:ws/pay`, `POST /employee/:ws/payslips/:itemId/download`, `GET /employee/:ws/schedule`, `PATCH /employee/:ws/profile`, `POST /auth/sessions/revoke` |

Errors are `{ "error": code, "message": text, "detail"? }` (e.g. `blocking_issues` carries the
issue list). Rate limits (`apps/api/src/rateLimit.ts`): invitations 20/h per organization, join
page 60/10 min per IP, activations 10/15 min per IP and 5/h per link, clock actions 20/min per
employee, correction requests 20/h, exports 30/10 min per user.

## Data model

`organization_payroll_settings`, `departments`, `employees` (the auth link is `employees.user_id`),
`employee_invitations`, `pay_rate_history`, `overtime_policies`, `break_policies`, `staff_holidays`,
`shift_schedules`, `attendance_sessions`, `break_sessions`, `attendance_events` (append-only),
`timesheet_adjustments` (correction requests and applied corrections), `timesheet_approvals`,
`payroll_periods`, `payroll_items`, `payroll_adjustments`, `payroll_approvals`, `payroll_payments`,
`payment_allocations`. Staff roles are `memberships.staff_role`; organizations are `workspaces`;
the audit trail is the existing `audit_logs` (actions `staff.*` and `payroll.*`).

Every table has `workspace_id` and the `tenant_isolation` RLS policy; reads go through
`withTenant`. Money: `*_minor` bigint + `currency`; rates `DECIMAL(14,4)`; multipliers
`DECIMAL(8,4)`. Database-enforced: one open shift per employee, one open break per shift, one live
invitation per employee, one live pay period per range, unique employee number and email per
organization, unique payment idempotency key, unique payment reference per employee and method,
non-negative/positive amounts, valid statuses, and the freeze triggers on locked payroll items,
locked shifts and their breaks.

## Security notes

- Tokens: invitations 256-bit random, SHA-256 at rest; download links 192-bit, one use, 5 min,
  bound to the requesting user, SHA-256 as the coordinator key.
- Passwords never touch our database or logs; the policy is enforced server-side.
- Encryption in transit: HTTPS (Cloudflare) to the Worker, Hyperdrive/Tunnel to Postgres. Encryption
  at rest is the database volume's: staff records are not additionally encrypted per field (names,
  emails, phone numbers and pay are visible to authorized roles only).
- Retention: staff records are kept while the organization exists (payroll records usually have a
  statutory retention period; deleting them is deliberately not offered in the UI). Deleting the
  workspace cascades to all staff data. Employees can't delete their own records.

## Not included

Stated plainly, because the request asked for these where possible:

- **Statutory payroll** (tax, social security, superannuation/pension, leave accrual, award or
  penalty rates) for any jurisdiction: not implemented; all pay is labelled estimated.
- **Money transfers / payment-provider integration and webhooks**: none — no provider credentials
  were available, and recording is kept separate from paying.
- **Receipt attachments** on payments: not implemented (R2 isn't enabled in production).
- **MFA**: Firebase multi-factor needs the Identity Platform upgrade on the Firebase project; not
  enabled, so not offered.
- **WebSockets/SSE**: live views poll (10 s attendance, 30 s dashboards), as the rest of the app does.
- **Locations / geofencing**: no location data is collected; the live board filters by employee,
  department, position, manager and status.

## Tests

| Suite | File | Covers |
| --- | --- | --- |
| Unit | `packages/shared/test/staff.test.ts` | money and rounding, currencies' minor units, DST and half-hour zones, daily/weekly/double-time overtime, overnight and DST shifts, holidays, overlapping sessions, effective-dated rates, breaks and the stale cap, pay cycles, report ranges and comparisons, flags, live status, permissions, password policy |
| Unit | `packages/core/test/staffFiles.test.ts` | CSV formula-injection guard, XLSX structure, ZIP CRCs, PDF cross-reference table and text encoding |
| Integration | `apps/api/test/staff.test.ts` | the onboarding/invitation flow (incl. invalid, expired, revoked, reused, copied links, existing accounts), clocking with server time and a refresh, breaks, concurrency and idempotency, deactivation, overnight and DST shifts, overtime, approval, payroll workflow, locking and freeze triggers, rate changes preserving history, payments (partial, overpayment, duplicates, references, reversal), analytics presets, CSV/XLSX/PDF/payslip/statement downloads, employee data isolation, staff roles, organization isolation including RLS |
| End to end | `apps/web/e2e/staff.spec.ts` | the browser journey: add employee → invitation email → set password → portal → clock in → refresh → break → clock out → manager approves → payroll → payment |
