import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { systemDb, withTenant } from "@app/db";
import { sha256Hex } from "@app/shared";
import { clean, cookiesFrom, createWorkspace, ORIGIN, setup, signIn, teardown, type InjectResponse, type TestCtx } from "./helpers.js";

/**
 * Staff Management, Time & Attendance and Payroll, end to end through the API against a real
 * Postgres (RLS, partial unique indexes and freeze triggers included). Time is the server's: the
 * tests move the process clock (Date only) to put clock actions at known instants.
 */

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
});
afterAll(async () => teardown(ctx));
beforeEach(async () => {
  await clean(ctx);
  ctx.mailer.sent.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

type Headers = Record<string, string>;
async function call(method: string, url: string, headers: Headers, payload?: unknown, extra: Headers = {}): Promise<InjectResponse> {
  return ctx.app.inject({ method, url, headers: { ...headers, ...extra }, payload });
}
const ok = (r: InjectResponse, status = 200) => {
  if (r.statusCode !== status) throw new Error(`expected ${status}, got ${r.statusCode}: ${r.body}`);
  return r.json();
};

async function org(name: string) {
  const owner = await signIn(ctx, `owner-${name}`, `owner-${name}@example.com`);
  const ws = await createWorkspace(ctx, owner.headers, name);
  return { owner, ws, h: owner.headers };
}

const baseEmployee = {
  jobTitle: "Barista",
  employmentType: "full_time",
  joinedOn: "2026-10-01",
  standardWeeklyMinutes: 2400,
  workingDays: [1, 2, 3, 4, 5],
};

async function hire(h: Headers, ws: string, fullName: string, email: string, extra: Record<string, unknown> = {}) {
  const r = await call("POST", `/workspaces/${ws}/staff/employees`, h, { ...baseEmployee, fullName, email, hourlyRate: "20", ...extra });
  return ok(r, 201).employee as { id: string; employeeNumber: string; hourlyRate?: string | null };
}

const tokenFromMail = (to: string) => {
  const m = [...ctx.mailer.sent].reverse().find((s) => s.to === to);
  const token = /join\?token=([A-Za-z0-9_%-]+)/.exec(m?.text ?? "")?.[1];
  if (!token) throw new Error(`no invitation email to ${to}`);
  return decodeURIComponent(token);
};

/** Invite by email, accept with a password, sign in as the employee. */
async function join(h: Headers, ws: string, employeeId: string, email: string) {
  ok(await call("POST", `/workspaces/${ws}/staff/employees/${employeeId}/invitations`, h, { delivery: "email" }));
  const token = tokenFromMail(email);
  const accepted = await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" });
  ok(accepted);
  // Accepting signs the employee in (the response sets the session cookies).
  const cookie = cookiesFrom(accepted);
  expect(cookie).toMatch(/__session=/);
  return { cookie, ...ORIGIN };
}

const key = () => `k-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const clock = (eh: Headers, ws: string, action: string, payload: Record<string, unknown> = {}, k = key()) =>
  call("POST", `/employee/${ws}/attendance/${action}`, eh, payload, { "idempotency-key": k });

async function setTz(h: Headers, ws: string, timezone: string, extra: Record<string, unknown> = {}) {
  ok(await call("PUT", `/workspaces/${ws}/staff/settings`, h, { timezone, payCycleAnchor: "2026-10-05", weekStartsOn: 1, ...extra }));
}

describe("employee onboarding and invitations", () => {
  it("admin creates an employee, the invitation is emailed, and the employee registers and signs in", async () => {
    at("2026-10-14T10:00:00Z");
    const { ws, h } = await org("Acme");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    expect(e.employeeNumber).toBe("EMP-0001");
    expect(e.hourlyRate).toBe("20.00");
    const second = await hire(h, ws, "Sam Lee", "sam@example.com");
    expect(second.employeeNumber).toBe("EMP-0002");

    const inv = ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "email" }));
    expect(inv.emailed).toBe(true);
    expect(inv.url).toBeUndefined(); // emailed links never go to the inviter

    const mail = ctx.mailer.sent.find((m) => m.to === "jane@example.com")!;
    expect(mail.subject).toContain("Acme");
    expect(mail.text).toContain("Barista");
    expect(mail.text).toMatch(/expires on/);
    expect(mail.html).toContain("Set up my account");
    expect(mail.text).not.toContain("20.00"); // no pay in the invitation

    const token = tokenFromMail("jane@example.com");
    const stored = await systemDb.employeeInvitation.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt.getTime() - Date.now()).toBe(48 * 3_600_000);

    const look = ok(await call("GET", `/staff/invitations/lookup?token=${encodeURIComponent(token)}`, {}));
    expect(look).toMatchObject({ ok: true, employeeName: "Jane Doe", organization: "Acme", position: "Barista", accountExists: false });
    expect(JSON.stringify(look)).not.toMatch(/20\.00|hourly/i);

    const mismatch = await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-43" });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe("password_mismatch");
    const weak = await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "password", confirmPassword: "password" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("weak_password");

    const accepted = ok(await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" }));
    expect(accepted.emailVerified).toBe(true);
    expect([...ctx.auth.users.values()].find((u) => u.email === "jane@example.com")?.password).toBe("Correct-Horse-42"); // handed to the identity provider only
    expect(await systemDb.user.count({ where: { email: "jane@example.com" } })).toBe(1);

    // Single use: the same link can't create a second account (replay).
    const again = await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/invitation_/);

    // Sign in through the normal login (Cognito) and land in the portal.
    const jane = await signIn(ctx, "pw-jane@example.com", "jane@example.com");
    const me = ok(await call("GET", "/me", jane.headers));
    expect(me.workspaces).toEqual([]);
    expect(me.employments).toEqual([expect.objectContaining({ workspaceId: ws, fullName: "Jane Doe", jobTitle: "Barista" })]);
    const dash = ok(await call("GET", `/employee/${ws}/dashboard`, jane.headers));
    expect(dash.employee.fullName).toBe("Jane Doe");
    expect(dash.state.status).toBe("clocked_out");
  });

  it("rejects invalid, expired, revoked and reused invitations", async () => {
    const { ws, h } = await org("Acme");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const bogus = ok(await call("GET", "/staff/invitations/lookup?token=not-a-real-token-at-all-xx", {}));
    expect(bogus).toMatchObject({ ok: false, problem: "invalid" });

    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "email" }));
    const first = tokenFromMail("jane@example.com");
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "email" })); // resend
    const second = tokenFromMail("jane@example.com");
    expect(second).not.toBe(first);
    expect(ok(await call("GET", `/staff/invitations/lookup?token=${first}`, {})).problem).toBe("revoked");

    await systemDb.employeeInvitation.updateMany({ where: { tokenHash: sha256Hex(second) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(ok(await call("GET", `/staff/invitations/lookup?token=${second}`, {})).problem).toBe("expired");
    const expired = await call("POST", "/staff/invitations/accept", ORIGIN, { token: second, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error).toBe("invitation_expired");

    // Revoke
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "email" }));
    const third = tokenFromMail("jane@example.com");
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations/revoke`, h, {}));
    expect(ok(await call("GET", `/staff/invitations/lookup?token=${third}`, {})).problem).toBe("revoked");
  });

  it("a copied link creates an account that must verify its email before the portal opens", async () => {
    const { ws, h } = await org("Acme");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const inv = ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "link" }));
    expect(inv.url).toMatch(/\/join\?token=/);
    const token = decodeURIComponent(/token=([^&]+)/.exec(inv.url)![1]!);
    const res = ok(await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" }));
    expect(res.emailVerified).toBe(false);
    const jane = await signIn(ctx, "pw-jane@example.com", "jane@example.com", false);
    const denied = await call("GET", `/employee/${ws}/dashboard`, jane.headers);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("email_unverified");
  });

  it("someone with an account already signs in and joins with the invitation", async () => {
    const { ws, h } = await org("Acme");
    const existing = await signIn(ctx, "merchant-uid", "jane@example.com");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/invitations`, h, { delivery: "email" }));
    const token = tokenFromMail("jane@example.com");
    expect(ok(await call("GET", `/staff/invitations/lookup?token=${token}`, {})).accountExists).toBe(true);
    const r = await call("POST", "/staff/invitations/accept", ORIGIN, { token, password: "Correct-Horse-42", confirmPassword: "Correct-Horse-42" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("account_exists");
    const someoneElse = await signIn(ctx, "other-uid", "other@example.com");
    expect((await call("POST", "/staff/invitations/accept-existing", someoneElse.headers, { token })).statusCode).toBe(403);
    ok(await call("POST", "/staff/invitations/accept-existing", existing.headers, { token }));
    expect((await systemDb.employee.findUniqueOrThrow({ where: { id: e.id } })).userId).toBe(existing.user.id);
  });
});

describe("attendance", () => {
  it("clock in, refresh, break, clock out: hours and pay from server time, not the device clock", async () => {
    at("2026-10-14T08:00:00Z");
    const { ws, h } = await org("Acme");
    await setTz(h, ws, "UTC");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const eh = await join(h, ws, e.id, "jane@example.com");

    at("2026-10-14T09:00:00Z");
    const ci = ok(await clock(eh, ws, "clock-in", { clientTime: "2020-01-01T00:00:00.000Z", timezone: "Pacific/Auckland" }));
    expect(ci.state.status).toBe("working");
    expect(new Date(ci.state.session.clockInAt).toISOString()).toBe("2026-10-14T09:00:00.000Z");
    const ev = await systemDb.attendanceEvent.findFirstOrThrow({ where: { type: "clock_in" } });
    expect(ev.clientTime?.toISOString()).toBe("2020-01-01T00:00:00.000Z"); // kept for audit only

    // A refresh (or another device) an hour later sees the same running shift.
    at("2026-10-14T10:00:00Z");
    const refreshed = ok(await call("GET", `/employee/${ws}/attendance/me`, eh));
    expect(new Date(refreshed.session.clockInAt).toISOString()).toBe("2026-10-14T09:00:00.000Z");
    expect(refreshed.session.workedSeconds).toBe(3600);
    expect(new Date(refreshed.serverTime).toISOString()).toBe("2026-10-14T10:00:00.000Z");

    at("2026-10-14T12:00:00Z");
    expect(ok(await clock(eh, ws, "break/start", { kind: "meal" })).state.status).toBe("on_break");
    expect((await clock(eh, ws, "break/start", { kind: "meal" })).statusCode).toBe(409);
    at("2026-10-14T12:30:00Z");
    expect(ok(await clock(eh, ws, "break/end")).state.status).toBe("working");

    at("2026-10-14T17:30:00Z");
    const out = ok(await clock(eh, ws, "clock-out"));
    expect(out.state.status).toBe("clocked_out");
    expect(out.summary).toMatchObject({ workedSeconds: 8 * 3600, unpaidBreakSeconds: 1800, estimatedEarnings: "160.00", currency: "USD" });
    expect((await clock(eh, ws, "clock-out")).statusCode).toBe(409);
  });

  it("simultaneous and repeated clock-ins never open two shifts", async () => {
    at("2026-10-14T09:00:00Z");
    const { ws, h } = await org("Acme");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const eh = await join(h, ws, e.id, "jane@example.com");
    const results = await Promise.all(Array.from({ length: 6 }, () => clock(eh, ws, "clock-in")));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(await systemDb.attendanceSession.count({ where: { employeeId: e.id } })).toBe(1);
    // A retry with the same Idempotency-Key replays rather than failing or acting twice.
    const k = key();
    ok(await clock(eh, ws, "clock-out", {}, k));
    const replay = ok(await clock(eh, ws, "clock-out", {}, k));
    expect(replay.replayed).toBe(true);
  });

  it("deactivation closes the open shift and stops further clock-ins", async () => {
    at("2026-10-14T09:00:00Z");
    const { ws, h } = await org("Acme");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const eh = await join(h, ws, e.id, "jane@example.com");
    ok(await clock(eh, ws, "clock-in"));
    at("2026-10-14T11:00:00Z");
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/deactivate`, h, { reason: "Left the company" }));
    const s = await systemDb.attendanceSession.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(s.clockOutAt?.toISOString()).toBe("2026-10-14T11:00:00.000Z");
    expect(s.flags).toContain("closed_by_manager");
    const denied = await clock(eh, ws, "clock-in");
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("deactivated");
  });

  it("splits overnight shifts at local midnight", async () => {
    at("2026-10-14T21:00:00Z");
    const { ws, h } = await org("Acme");
    await setTz(h, ws, "Australia/Sydney");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const eh = await join(h, ws, e.id, "jane@example.com");
    at("2026-10-14T11:00:00Z"); // 22:00 in Sydney (UTC+11)
    ok(await clock(eh, ws, "clock-in"));
    at("2026-10-14T19:00:00Z"); // 06:00 next day
    ok(await clock(eh, ws, "clock-out"));
    const report = ok(await call("GET", `/workspaces/${ws}/staff/reports?type=attendance&groupBy=day&preset=custom&from=2026-10-14&to=2026-10-15`, h));
    expect(report.rows.map((r: { group: string; worked: number }) => [r.group, r.worked / 3600])).toEqual([
      ["2026-10-14", 2],
      ["2026-10-15", 6],
    ]);
    const s = await systemDb.attendanceSession.findFirstOrThrow({ where: { employeeId: e.id } });
    expect(s.flags).toContain("overnight");
  });

  it("counts real elapsed time across a daylight saving change", async () => {
    at("2026-10-31T12:00:00Z");
    const { ws, h } = await org("Acme");
    await setTz(h, ws, "America/New_York");
    const e = await hire(h, ws, "Jane Doe", "jane@example.com");
    const eh = await join(h, ws, e.id, "jane@example.com");
    at("2026-11-01T04:00:00Z"); // 00:00 EDT on the night clocks go back
    ok(await clock(eh, ws, "clock-in"));
    at("2026-11-01T13:00:00Z"); // 08:00 EST
    const out = ok(await clock(eh, ws, "clock-out"));
    expect(out.summary.workedSeconds).toBe(9 * 3600); // 00:00 -> 08:00 local holds 9 real hours
    const report = ok(await call("GET", `/workspaces/${ws}/staff/reports?type=attendance&groupBy=day&preset=custom&from=2026-11-01&to=2026-11-01`, h));
    expect(report.rows[0].worked).toBe(9 * 3600);
  });
});

describe("payroll", () => {
  async function weekWithOvertime() {
    at("2026-10-12T07:00:00Z");
    const o = await org("Acme");
    await setTz(o.h, o.ws, "UTC");
    const pol = ok(
      await call("POST", `/workspaces/${o.ws}/staff/overtime-policies`, o.h, {
        name: "Over 8 h a day",
        dailyThresholdMinutes: 480,
        weeklyThresholdMinutes: null,
        multiplier: "1.5",
        doubleTimeDailyThresholdMinutes: null,
        doubleTimeMultiplier: null,
        holidayMultiplier: "1",
      }),
    );
    const e = await hire(o.h, o.ws, "Jane Doe", "jane@example.com", { overtimePolicyId: pol.id });
    const eh = await join(o.h, o.ws, e.id, "jane@example.com");
    const shift = async (from: string, to: string) => {
      at(from);
      ok(await clock(eh, o.ws, "clock-in"));
      at(to);
      ok(await clock(eh, o.ws, "clock-out"));
    };
    await shift("2026-10-12T09:00:00Z", "2026-10-12T19:00:00Z"); // 10 h: 8 regular + 2 overtime
    await shift("2026-10-13T09:00:00Z", "2026-10-13T17:00:00Z"); // 8 h
    at("2026-10-20T09:00:00Z");
    // A week on: sessions last five days, so both sign in again, as they would.
    const owner = await signIn(ctx, "owner-Acme", "owner-Acme@example.com");
    const again = await call("POST", "/auth/login", ORIGIN, { email: "jane@example.com", password: "Correct-Horse-42" });
    ok(again);
    return { ...o, owner, h: owner.headers, e, eh: { cookie: cookiesFrom(again), ...ORIGIN } };
  }

  it("calculates overtime, needs approved hours, approves, locks and keeps history when wages change", async () => {
    const { ws, h, e, eh } = await weekWithOvertime();
    // Unapproved hours block the payroll.
    const created = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-12", endDate: "2026-10-18", payDate: "2026-10-21" }), 201).period;
    expect(created.issues.map((i: { code: string }) => i.code)).toContain("unapproved_hours");
    const blocked = await call("POST", `/workspaces/${ws}/staff/payroll/periods/${created.id}/submit`, h, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("blocking_issues");

    // Review and approve the timesheet.
    const sheet = ok(await call("GET", `/workspaces/${ws}/staff/timesheets?from=2026-10-12&to=2026-10-18&status=pending`, h));
    expect(sheet.items).toHaveLength(2);
    ok(await call("POST", `/workspaces/${ws}/staff/timesheets/approve`, h, { sessionIds: sheet.items.map((s: { id: string }) => s.id) }));

    const calc = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${created.id}/calculate`, h, {})).period;
    expect(calc.issues).toEqual([]);
    const item = calc.items[0];
    expect(item).toMatchObject({ regularSeconds: 16 * 3600, overtimeSeconds: 2 * 3600, gross: "380.00", net: "380.00", outstanding: "380.00" });
    expect(item.lines).toEqual([
      expect.objectContaining({ category: "regular", hourlyRate: "20.00", seconds: 16 * 3600, amount: "320.00" }),
      expect.objectContaining({ category: "overtime", hourlyRate: "20.00", multiplier: "1.5", seconds: 2 * 3600, amount: "60.00" }),
    ]);

    // Overlapping periods are refused (no double counting).
    const overlap = await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-15", endDate: "2026-10-21" });
    expect(overlap.statusCode).toBe(409);

    const submitted = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${created.id}/submit`, h, {})).period;
    expect(submitted.status).toBe("pending_approval");
    const stale = await call("POST", `/workspaces/${ws}/staff/payroll/periods/${created.id}/approve`, h, { version: submitted.version - 1 });
    expect(stale.statusCode).toBe(409);
    const approved = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${created.id}/approve`, h, { version: submitted.version })).period;
    expect(approved.status).toBe("approved");
    expect(approved.locked).toBe(true);

    // Paid shifts are frozen.
    const sessionId = sheet.items[0].id;
    const edit = await call("POST", `/workspaces/${ws}/staff/timesheets/${sessionId}/corrections`, h, { clockInAt: "2026-10-12T08:00:00Z", clockOutAt: "2026-10-12T19:00:00Z", note: "Came in early" });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("locked");
    // ... even below the API.
    await expect(systemDb.attendanceSession.update({ where: { id: sessionId }, data: { clockInAt: new Date("2026-10-12T08:00:00Z") } })).rejects.toThrow(/finalized payroll/);
    await expect(systemDb.payrollItem.update({ where: { id: item.id }, data: { grossMinor: 1n } })).rejects.toThrow(/finalized pay period/);

    // Nor can hours be added to a day the approved payroll already covers (they'd never be paid).
    const late = await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/shifts`, h, { clockInAt: "2026-10-14T09:00:00Z", clockOutAt: "2026-10-14T12:00:00Z", note: "Forgot to clock in" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("period_locked");
    // A period that hasn't ended can be drafted but not sent for approval.
    const current = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-19", endDate: "2026-10-25" }), 201).period;
    const early = await call("POST", `/workspaces/${ws}/staff/payroll/periods/${current.id}/submit`, h, {});
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("period_not_over");

    // A raise can't reach back into approved pay, and later ones leave it alone.
    const backdated = await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/pay-rates`, h, { hourlyRate: "25", effectiveFrom: "2026-10-13" });
    expect(backdated.statusCode).toBe(409);
    ok(await call("POST", `/workspaces/${ws}/staff/employees/${e.id}/pay-rates`, h, { hourlyRate: "25", effectiveFrom: "2026-10-19" }));
    const after = ok(await call("GET", `/workspaces/${ws}/staff/payroll/periods/${created.id}`, h)).period;
    expect(after.items[0].gross).toBe("380.00");

    // The employee sees the approved period (never drafts).
    const pay = ok(await call("GET", `/employee/${ws}/pay`, eh));
    expect(pay.items).toHaveLength(1);
    expect(pay.items[0]).toMatchObject({ gross: "380.00", outstanding: "380.00" });
  });

  it("records partial payments, refuses overpayments and duplicates, and reverses", async () => {
    const { ws, h, e } = await weekWithOvertime();
    const sheet = ok(await call("GET", `/workspaces/${ws}/staff/timesheets?from=2026-10-12&to=2026-10-18`, h));
    ok(await call("POST", `/workspaces/${ws}/staff/timesheets/approve`, h, { sessionIds: sheet.items.map((s: { id: string }) => s.id) }));
    const p = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-12", endDate: "2026-10-18" }), 201).period;
    const s = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/submit`, h, {})).period;
    const itemId = s.items[0].id;

    const pay = (amount: string, k = key(), extra: Record<string, unknown> = {}) =>
      call("POST", `/workspaces/${ws}/staff/payroll/payments`, h, { employeeId: e.id, payrollItemId: itemId, amount, paidOn: "2026-10-20", method: "bank_transfer", ...extra }, { "idempotency-key": k });

    // Not approved yet: nothing can be paid.
    expect((await pay("100")).statusCode).toBe(409);
    ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/approve`, h, { version: s.version }));

    // Without an Idempotency-Key the request is refused outright.
    expect((await call("POST", `/workspaces/${ws}/staff/payroll/payments`, h, { employeeId: e.id, payrollItemId: itemId, amount: "1", paidOn: "2026-10-20", method: "cash" })).statusCode).toBe(400);

    const k1 = key();
    const first = ok(await pay("200", k1, { reference: "TX-1" }), 201);
    expect(first.payment.amount).toBe("200.00");
    // The same submission again (double click, retry): one payment.
    const replay = ok(await pay("200", k1, { reference: "TX-1" }));
    expect(replay.replayed).toBe(true);
    expect(await systemDb.payrollPayment.count()).toBe(1);

    let period = ok(await call("GET", `/workspaces/${ws}/staff/payroll/periods/${p.id}`, h)).period;
    expect(period.status).toBe("partially_paid");
    expect(period.items[0]).toMatchObject({ paid: "200.00", outstanding: "180.00", paymentStatus: "partially_paid" });

    const over = await pay("180.01");
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toBe("overpayment");
    expect((await pay("50", key(), { reference: "TX-1" })).json().error).toBe("duplicate_reference");
    ok(await pay("90"), 201);
    const twin = await pay("90");
    expect(twin.json().error).toBe("possible_duplicate");
    ok(await pay("90", key(), { confirmDuplicate: true }), 201);

    period = ok(await call("GET", `/workspaces/${ws}/staff/payroll/periods/${p.id}`, h)).period;
    expect(period.status).toBe("paid");
    expect(period.totals.USD).toMatchObject({ net: "380.00", paid: "380.00", outstanding: "0.00" });

    // Reversing a payment brings the balance back.
    ok(await call("POST", `/workspaces/${ws}/staff/payroll/payments/${first.payment.id}/reverse`, h, { comment: "Bank returned it" }));
    period = ok(await call("GET", `/workspaces/${ws}/staff/payroll/periods/${p.id}`, h)).period;
    expect(period.status).toBe("partially_paid");
    expect(period.items[0].outstanding).toBe("200.00");
    const history = ok(await call("GET", `/workspaces/${ws}/staff/payroll/payments?employeeId=${e.id}`, h));
    expect(history.items.map((x: { status: string }) => x.status).sort()).toEqual(["completed", "completed", "reversed"]);
  });

  it("won't approve figures that changed after they were calculated", async () => {
    const { ws, h } = await weekWithOvertime();
    const sheet = ok(await call("GET", `/workspaces/${ws}/staff/timesheets?from=2026-10-12&to=2026-10-18`, h));
    ok(await call("POST", `/workspaces/${ws}/staff/timesheets/approve`, h, { sessionIds: sheet.items.map((s: { id: string }) => s.id) }));
    const p = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-12", endDate: "2026-10-18" }), 201).period;
    const s = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/submit`, h, {})).period;
    // A manager corrects a shift after submission.
    ok(await call("POST", `/workspaces/${ws}/staff/timesheets/${sheet.items[0].id}/corrections`, h, { clockInAt: sheet.items[0].clockInAt, clockOutAt: new Date(new Date(sheet.items[0].clockOutAt).getTime() - 3_600_000).toISOString(), note: "Left an hour early" }));
    const r = await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/approve`, h, { version: s.version });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("figures_changed");
    expect(ok(await call("GET", `/workspaces/${ws}/staff/payroll/periods/${p.id}`, h)).period.status).toBe("correction_required");
  });

  it("filters analytics by week, month and year, and exports CSV, Excel and PDF once", async () => {
    const { ws, h, e, eh } = await weekWithOvertime();
    for (const preset of ["this_week", "last_week", "this_month", "last_month", "this_year", "last_year"]) {
      const k = ok(await call("GET", `/workspaces/${ws}/staff/analytics?preset=${preset}`, h));
      expect(k.kpis.length).toBeGreaterThanOrEqual(16);
    }
    const lastWeek = ok(await call("GET", `/workspaces/${ws}/staff/analytics?preset=last_week`, h));
    const kpi = (key: string) => lastWeek.kpis.find((x: { key: string }) => x.key === key);
    expect(kpi("regular_hours").value).toBe(16 * 3600);
    expect(kpi("overtime_hours").value).toBe(2 * 3600);
    const month = ok(await call("GET", `/workspaces/${ws}/staff/analytics?preset=this_month`, h));
    expect(month.kpis.find((x: { key: string }) => x.key === "cost_month").value).toBe("380.00");
    for (const g of ["day", "week", "month"]) {
      const t = ok(await call("GET", `/workspaces/${ws}/staff/analytics/trends?preset=this_month&granularity=${g}`, h));
      expect(t.granularity).toBe(g);
      const sum = t.buckets.reduce((a: number, b: { regularSeconds: number; overtimeSeconds: number }) => a + b.regularSeconds + b.overtimeSeconds, 0);
      expect(sum).toBe(18 * 3600);
    }
    const custom = await call("GET", `/workspaces/${ws}/staff/analytics?preset=custom&from=2026-10-20&to=2026-10-01`, h);
    expect(custom.statusCode).toBe(400);

    const download = async (payload: unknown) => {
      const { url } = ok(await call("POST", `/workspaces/${ws}/staff/exports`, h, payload));
      const res = await call("GET", url.replace(/^\/api/, ""), h);
      return { res, url };
    };
    const csv = await download({ kind: "report", format: "csv", report: { type: "attendance", groupBy: "employee", preset: "this_month" } });
    expect(csv.res.statusCode).toBe(200);
    expect(csv.res.headers["content-type"]).toContain("text/csv");
    expect(csv.res.headers["content-disposition"]).toContain("attachment");
    expect(csv.res.body).toContain("Jane Doe (EMP-0001)");
    expect(csv.res.body).toContain("18.00");
    // Single use.
    expect((await call("GET", csv.url.replace(/^\/api/, ""), h)).statusCode).toBe(404);

    const xlsx = await download({ kind: "report", format: "xlsx", report: { type: "attendance", groupBy: "day", preset: "this_month" } });
    expect(xlsx.res.headers["content-type"]).toContain("spreadsheetml");
    expect(xlsx.res.body.slice(0, 2)).toBe("PK");
    const pdf = await download({ kind: "report", format: "pdf", report: { type: "attendance", groupBy: "employee", preset: "this_month" } });
    expect(pdf.res.body.startsWith("%PDF-1.4")).toBe(true);

    // Payslip: approve the period, then the employee downloads their own.
    const sheet = ok(await call("GET", `/workspaces/${ws}/staff/timesheets?from=2026-10-12&to=2026-10-18`, h));
    ok(await call("POST", `/workspaces/${ws}/staff/timesheets/approve`, h, { sessionIds: sheet.items.map((s: { id: string }) => s.id) }));
    const p = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods`, h, { startDate: "2026-10-12", endDate: "2026-10-18" }), 201).period;
    const s = ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/submit`, h, {})).period;
    ok(await call("POST", `/workspaces/${ws}/staff/payroll/periods/${p.id}/approve`, h, { version: s.version }));
    const mine = ok(await call("POST", `/employee/${ws}/payslips/${s.items[0].id}/download`, eh, {}));
    const slip = await call("GET", mine.url.replace(/^\/api/, ""), eh);
    expect(slip.statusCode).toBe(200);
    expect(slip.headers["content-type"]).toBe("application/pdf");
    expect(slip.body).toContain("Jane Doe");
    // The owner can't use the employee's link, and vice versa.
    const again = ok(await call("POST", `/employee/${ws}/payslips/${s.items[0].id}/download`, eh, {}));
    expect((await call("GET", again.url.replace(/^\/api/, ""), h)).statusCode).toBe(404);
    // ... and their attempt doesn't use the link up for its owner.
    expect((await call("GET", again.url.replace(/^\/api/, ""), eh)).statusCode).toBe(200);

    const payrollCsv = await download({ kind: "report", format: "csv", report: { type: "payroll", groupBy: "employee", preset: "this_month" } });
    expect(payrollCsv.res.body).toContain("380.00");
    const statement = await download({ kind: "statement", employeeId: e.id, preset: "this_year" });
    expect(statement.res.body.startsWith("%PDF")).toBe(true);
  });
});

describe("access control and tenant isolation", () => {
  it("employees only ever see their own records", async () => {
    at("2026-10-14T09:00:00Z");
    const { ws, h } = await org("Acme");
    const a = await hire(h, ws, "Jane Doe", "jane@example.com");
    const b = await hire(h, ws, "Sam Lee", "sam@example.com");
    const ah = await join(h, ws, a.id, "jane@example.com");
    const bh = await join(h, ws, b.id, "sam@example.com");
    ok(await clock(bh, ws, "clock-in"));
    at("2026-10-14T12:00:00Z");
    ok(await clock(bh, ws, "clock-out"));
    // Jane's timesheet holds only Jane's shifts.
    expect(ok(await call("GET", `/employee/${ws}/timesheets?from=2026-10-14&to=2026-10-14`, ah)).items).toEqual([]);
    // No admin endpoint answers an employee.
    for (const url of [`/workspaces/${ws}/staff/employees`, `/workspaces/${ws}/staff/employees/${b.id}`, `/workspaces/${ws}/staff/timesheets?from=2026-10-14&to=2026-10-14`, `/workspaces/${ws}/staff/payroll/periods`, `/workspaces/${ws}/staff/analytics`]) {
      expect((await call("GET", url, ah)).statusCode).toBe(404);
    }
    // Jane can't correct Sam's shift.
    const samShift = await systemDb.attendanceSession.findFirstOrThrow({ where: { employeeId: b.id } });
    const r = await call("POST", `/employee/${ws}/corrections`, ah, { sessionId: samShift.id, clockInAt: "2026-10-14T08:00:00Z", clockOutAt: "2026-10-14T12:00:00Z", reason: "mine now" });
    expect(r.statusCode).toBe(404);
  });

  it("staff roles: HR can't see pay, payroll can't edit people, supervisors see only their team", async () => {
    at("2026-10-14T09:00:00Z");
    const { ws, h } = await org("Acme");
    const mk = async (uid: string, role: string, staffRole: string) => {
      const u = await signIn(ctx, uid, `${uid}@example.com`);
      await systemDb.membership.create({ data: { workspaceId: ws, userId: u.user.id, role: role as "viewer", staffRole: staffRole as "hr_manager" } });
      return u;
    };
    const hr = await mk("hr", "viewer", "hr_manager");
    const payroll = await mk("payroll", "viewer", "payroll_manager");
    const sup = await mk("sup", "viewer", "supervisor");
    const team = await hire(h, ws, "On the team", "team@example.com", { managerUserId: sup.user.id });
    const other = await hire(h, ws, "Not on the team", "other@example.com");

    const withRate = await call("POST", `/workspaces/${ws}/staff/employees`, hr.headers, { ...baseEmployee, fullName: "New", email: "new@example.com", hourlyRate: "30" });
    expect(withRate.statusCode).toBe(403);
    const created = ok(await call("POST", `/workspaces/${ws}/staff/employees`, hr.headers, { ...baseEmployee, fullName: "New", email: "new@example.com" }), 201).employee;
    expect(created).not.toHaveProperty("hourlyRate");
    expect(ok(await call("GET", `/workspaces/${ws}/staff/employees/${team.id}`, hr.headers)).employee).not.toHaveProperty("hourlyRate");
    expect((await call("GET", `/workspaces/${ws}/staff/payroll/periods`, hr.headers)).statusCode).toBe(403);

    expect(ok(await call("GET", `/workspaces/${ws}/staff/employees/${team.id}`, payroll.headers)).employee.hourlyRate).toBe("20.00");
    expect((await call("PATCH", `/workspaces/${ws}/staff/employees/${team.id}`, payroll.headers, { jobTitle: "Manager" })).statusCode).toBe(403);

    const list = ok(await call("GET", `/workspaces/${ws}/staff/employees`, sup.headers));
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([team.id]);
    expect((await call("GET", `/workspaces/${ws}/staff/employees/${other.id}`, sup.headers)).statusCode).toBe(404);
    expect((await call("POST", `/workspaces/${ws}/staff/employees`, sup.headers, { ...baseEmployee, fullName: "X", email: "x@example.com" })).statusCode).toBe(403);

    // A member with no staff role has no access at all.
    const viewer = await signIn(ctx, "viewer", "viewer@example.com");
    await systemDb.membership.create({ data: { workspaceId: ws, userId: viewer.user.id, role: "viewer" } });
    expect((await call("GET", `/workspaces/${ws}/staff/employees`, viewer.headers)).statusCode).toBe(403);
  });

  it("keeps organizations completely apart", async () => {
    at("2026-10-14T09:00:00Z");
    const one = await org("One");
    const two = await org("Two");
    const e = await hire(one.h, one.ws, "Jane Doe", "jane@example.com");
    const eh = await join(one.h, one.ws, e.id, "jane@example.com");
    ok(await clock(eh, one.ws, "clock-in"));
    // The other organization's owner can't reach any of it, under either workspace id.
    expect((await call("GET", `/workspaces/${one.ws}/staff/employees`, two.h)).statusCode).toBe(404);
    expect((await call("GET", `/workspaces/${two.ws}/staff/employees/${e.id}`, two.h)).statusCode).toBe(404);
    expect(ok(await call("GET", `/workspaces/${two.ws}/staff/employees`, two.h)).items).toEqual([]);
    expect(ok(await call("GET", `/workspaces/${two.ws}/staff/attendance/live`, two.h)).rows).toEqual([]);
    expect((await call("POST", `/workspaces/${two.ws}/staff/employees/${e.id}/invitations`, two.h, { delivery: "link" })).statusCode).toBe(404);
    // The same email can be an employee in both, independently.
    await hire(two.h, two.ws, "Jane Doe", "jane@example.com");
    // An employee of one isn't an employee of the other.
    expect((await call("GET", `/employee/${two.ws}/dashboard`, eh)).statusCode).toBe(404);
    // And below the API, row level security hides one tenant's rows from the other.
    const seen = await withTenant(two.ws, (tx) => tx.employee.findMany({ where: { id: e.id } }));
    expect(seen).toEqual([]);
    const sessions = await withTenant(two.ws, (tx) => tx.attendanceSession.count());
    expect(sessions).toBe(0);
  });
});
