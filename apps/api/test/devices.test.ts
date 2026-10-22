import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { systemDb } from "@app/db";
import { CLIENT_IP_HEADER } from "../src/context.js";
import { CLIENT_GEO_HEADER } from "../src/devices.js";
import { clean, cookiesFrom, ORIGIN, setup, teardown, userOf, type TestCtx } from "./helpers.js";

/**
 * Settings → Security: the devices an account is signed in on (a row per session), signing one of
 * them out from another, and the account's sign-in activity, successful and failed.
 */

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

type Device = { ua: string; ip: string; geo?: string; hints?: Record<string, string> };
const PC: Device = { ua: WINDOWS, ip: "103.110.45.72", geo: "IN|Kerala|Kochi", hints: { "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-platform-version": '"15.0.0"' } };
const PHONE: Device = { ua: IPHONE, ip: "157.51.98.204", geo: "US|New%20York|New%20York" };

const from = (d: Device) => ({ "user-agent": d.ua, [CLIENT_IP_HEADER]: d.ip, ...(d.geo && { [CLIENT_GEO_HEADER]: d.geo }), ...d.hints });

/** Sign `user` in with their password from `device`: the cookie header that browser now sends. */
async function signInOn(device: Device, user: { email: string | null; password: string | null }) {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: { ...ORIGIN, ...from(device) }, payload: { email: user.email, password: user.password } });
  expect(res.statusCode).toBe(200);
  return cookiesFrom(res);
}

const on = (device: Device, cookie: string) => ({ ...ORIGIN, ...from(device), cookie });
const get = (url: string, headers: Record<string, string>) => ctx.app.inject({ method: "GET", url, headers });

async function twoDevices() {
  const u = ctx.auth.addUser({ sub: "u1", email: "owner@x.com", emailVerified: true });
  const pc = await signInOn(PC, u);
  const phone = await signInOn(PHONE, u);
  return { u, pc, phone };
}

describe("GET /auth/account/sessions", () => {
  it("lists this device first, then the others, each with its browser, address and place", async () => {
    const { pc } = await twoDevices();
    const res = await get("/auth/account/sessions", on(PC, pc));
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json();
    expect(sessions).toEqual([
      {
        id: expect.any(String),
        current: true,
        method: "password",
        device: { kind: "laptop", name: "Windows PC", browser: "Chrome 155.0.0.0", os: "Windows 11" },
        ip: "103.110.45.72",
        location: { country: "IN", region: "Kerala", city: "Kochi" },
        signedInAt: expect.any(String),
        lastActiveAt: expect.any(String),
        expiresAt: expect.any(String),
      },
      expect.objectContaining({ current: false, device: { kind: "phone", name: "iPhone", browser: "Safari 17.2", os: "iOS 17.2" }, ip: "157.51.98.204", location: { country: "US", region: "New York", city: "New York" } }),
    ]);
  });

  it("lists a session from before the list existed", async () => {
    const { pc } = await twoDevices();
    await systemDb.userSession.deleteMany({});
    const { sessions } = (await get("/auth/account/sessions", on(PC, pc))).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ current: true, device: { name: "Windows PC" } });
  });

  it("keeps an unknown place as no place, whatever the edge sent", async () => {
    const u = ctx.auth.addUser({ sub: "u1", email: "owner@x.com", emailVerified: true });
    const cookie = await signInOn({ ua: WINDOWS, ip: "203.0.113.1", geo: "XX||" }, u);
    const { sessions } = (await get("/auth/account/sessions", { cookie })).json();
    expect(sessions[0].location).toBeNull();
  });
});

describe("DELETE /auth/account/sessions/:id", () => {
  it("signs that device out at once, and takes it off the list", async () => {
    const { pc, phone } = await twoDevices();
    const { sessions } = (await get("/auth/account/sessions", on(PC, pc))).json();
    const other = sessions.find((s: { current: boolean }) => !s.current);
    const res = await ctx.app.inject({ method: "DELETE", url: `/auth/account/sessions/${other.id}`, headers: on(PC, pc) });
    expect(res.statusCode).toBe(200);
    expect((await get("/me", on(PHONE, phone))).statusCode).toBe(401);
    expect((await get("/me", on(PC, pc))).statusCode).toBe(200);
    expect((await get("/auth/account/sessions", on(PC, pc))).json().sessions).toHaveLength(1);
    const user = await userOf("u1");
    expect(await systemDb.authEvent.count({ where: { userId: user.id, type: "session_removed" } })).toBe(1);
    // Gone already: nothing to remove.
    expect((await ctx.app.inject({ method: "DELETE", url: `/auth/account/sessions/${other.id}`, headers: on(PC, pc) })).statusCode).toBe(404);
  });

  it("won't remove the device asking (that is Sign out), nor another account's device", async () => {
    const { pc } = await twoDevices();
    const mine = (await get("/auth/account/sessions", on(PC, pc))).json().sessions[0];
    const self = await ctx.app.inject({ method: "DELETE", url: `/auth/account/sessions/${mine.id}`, headers: on(PC, pc) });
    expect(self.statusCode).toBe(409);
    expect(self.json().error).toBe("current_session");

    const b = ctx.auth.addUser({ sub: "u2", email: "other@x.com", emailVerified: true });
    const theirs = await signInOn(PHONE, b);
    const res = await ctx.app.inject({ method: "DELETE", url: `/auth/account/sessions/${mine.id}`, headers: on(PHONE, theirs) });
    expect(res.statusCode).toBe(404);
    expect((await get("/me", on(PC, pc))).statusCode).toBe(200);
  });
});

describe("signing out", () => {
  it("takes this device off the list, and every device with sign out everywhere", async () => {
    const { u, pc, phone } = await twoDevices();
    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout", headers: on(PHONE, phone) })).statusCode).toBe(200);
    expect((await get("/auth/account/sessions", on(PC, pc))).json().sessions).toHaveLength(1);
    const third = await signInOn(PHONE, u);
    expect((await get("/auth/account/sessions", on(PC, pc))).json().sessions).toHaveLength(2);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout-all", headers: on(PHONE, third) })).statusCode).toBe(200);
    const user = await userOf("u1");
    expect(await systemDb.userSession.count({ where: { userId: user.id, endedAt: null } })).toBe(0);
  });

  it("after a password change, lists only this device, under its new session", async () => {
    const { u, pc } = await twoDevices();
    const res = await ctx.app.inject({ method: "POST", url: "/auth/account/password", headers: on(PC, pc), payload: { currentPassword: u.password, password: "a-new-password-1", confirmPassword: "a-new-password-1" } });
    expect(res.statusCode).toBe(200);
    const fresh = cookiesFrom(res);
    const { sessions } = (await get("/auth/account/sessions", on(PC, fresh))).json();
    expect(sessions).toEqual([expect.objectContaining({ current: true, device: expect.objectContaining({ name: "Windows PC" }) })]);
    // The same device: no new sign-in in the activity.
    const { events } = (await get("/auth/account/activity", on(PC, fresh))).json();
    expect(events.filter((e: { status: string }) => e.status === "success")).toHaveLength(2);
    const account = (await get("/auth/account", on(PC, fresh))).json();
    const changed = await systemDb.authEvent.findFirstOrThrow({ where: { type: "password_changed" } });
    expect(account.passwordChangedAt).toBe(changed.createdAt.toISOString());
  });
});

describe("GET /auth/account/activity", () => {
  it("lists sign-ins newest first, with failed ones at the password, and counts the failures", async () => {
    const { u, pc } = await twoDevices();
    const wrong = await ctx.app.inject({ method: "POST", url: "/auth/login", headers: { ...ORIGIN, ...from(PHONE) }, payload: { email: u.email, password: "not-the-password" } });
    expect(wrong.statusCode).toBe(401);
    // An address with no account here: nothing recorded anywhere.
    await ctx.app.inject({ method: "POST", url: "/auth/login", headers: { ...ORIGIN, ...from(PHONE) }, payload: { email: "nobody@x.com", password: "whatever-1" } });
    expect(await systemDb.authEvent.count({ where: { type: "sign_in_failed" } })).toBe(1);

    const { events, nextCursor } = (await get("/auth/account/activity", on(PC, pc))).json();
    expect(nextCursor).toBeNull();
    expect(events.map((e: { status: string; device: { name: string } }) => [e.status, e.device.name])).toEqual([
      ["failed", "iPhone"],
      ["success", "iPhone"],
      ["success", "Windows PC"],
    ]);
    expect(events[0]).toMatchObject({ step: "password", ip: "157.51.98.204", location: { country: "US", region: "New York", city: "New York" } });
    expect(events[2]).toMatchObject({ method: "password", location: { country: "IN", region: "Kerala", city: "Kochi" } });
    expect((await get("/auth/account", on(PC, pc))).json().failedSignIns).toBe(1);
  });

  it("pages with a cursor", async () => {
    const u = ctx.auth.addUser({ sub: "u1", email: "owner@x.com", emailVerified: true });
    let cookie = "";
    for (let i = 0; i < 3; i++) cookie = await signInOn(PC, u);
    const first = (await get("/auth/account/activity?limit=2", on(PC, cookie))).json();
    expect(first.events).toHaveLength(2);
    const second = (await get(`/auth/account/activity?limit=2&cursor=${first.nextCursor}`, on(PC, cookie))).json();
    expect(second.events).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it("is the account's own: a password and a date for each", async () => {
    const { pc } = await twoDevices();
    const account = (await get("/auth/account", on(PC, pc))).json();
    const identity = await systemDb.authIdentity.findFirstOrThrow({ where: { method: "password" } });
    expect(account.passwordChangedAt).toBe(identity.createdAt.toISOString());
    expect(account.failedSignIns).toBe(0);
    expect((await get("/auth/account/activity", {})).statusCode).toBe(401);
    expect((await get("/auth/account/sessions", {})).statusCode).toBe(401);
  });
});
