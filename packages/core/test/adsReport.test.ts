import { describe, expect, it } from "vitest";
import { addDays, eachDay, type AdDayRow, type AdsenseDayRow } from "@app/shared";
import { adsenseFigures, adsFigures, type AdConn, type AdsAsk } from "../src/reports/ads.js";

// Noon UTC on 19 Oct 2026: the 19th everywhere from Los Angeles to Melbourne... except where noted.
const NOW = new Date("2026-10-19T12:00:00Z");
const TODAY = "2026-10-19";
const d = (n: number) => addDays(TODAY, n);

const conn = (over: Partial<AdConn> & Pick<AdConn, "id">): AdConn => ({
  provider: "meta",
  accountId: `act_${over.id}`,
  accountName: `Account ${over.id}`,
  currency: "USD",
  timezone: "UTC",
  status: "active",
  errorCode: null,
  accountStatus: null,
  lastSyncedAt: new Date("2026-10-19T11:00:00Z"),
  // What the first sync brings: the 90 days before connecting; synced up to today.
  historyFrom: d(-89),
  syncedThrough: TODAY,
  ...over,
});

const row = (c: AdConn, day: string, over: Partial<AdDayRow> = {}): AdDayRow & { connectionId: string } => ({
  connectionId: c.id,
  provider: c.provider as "meta" | "google",
  accountId: c.accountId,
  campaignId: "1",
  campaignName: "Spring",
  day,
  spend: 10,
  impressions: 1000,
  clicks: 30,
  linkClicks: 20,
  conversions: 1,
  conversionValue: 40,
  purchases: 1,
  purchaseValue: 40,
  leads: 0,
  ...over,
});

/** Every day of `from`..`to` for `c`, one row each. */
const daily = (c: AdConn, from: string, to: string, over: Partial<AdDayRow> = {}) => eachDay(from, to).map((day) => row(c, day, over));

/** "Last 7 days" on the 19th: compared with the 7 before, until the same time of day. */
const week = (over: Partial<AdsAsk> = {}): AdsAsk => ({
  range: { from: d(-6), to: TODAY },
  previous: { from: d(-13), to: d(-7), until: "12:00:00" },
  storeCurrency: "USD",
  storeTimeZone: "UTC",
  netSales: 1000,
  now: NOW,
  ...over,
});

describe("ad figures cover only the days the accounts have stored", () => {
  it("adds up an account that covers every day, and compares whole days only: through yesterday on both sides", () => {
    const a = conn({ id: "a" });
    const rows = daily(a, d(-13), TODAY);
    const m = adsFigures([a], rows, week())!;
    expect(m.coverage).toEqual({ from: d(-89), through: TODAY, complete: true });
    expect(m.current).toMatchObject({ spend: 70, linkClicks: 140, purchases: 7, purchaseValue: 280, roas: 4 });
    expect(m.partial).toBeNull();
    // Today is still running: 13–18 Oct against 6–11 Oct, six whole days each.
    expect(m.compared).toMatchObject({ current: { from: d(-6), to: d(-1), totals: { spend: 60 } }, previous: { from: d(-13), to: d(-8), totals: { spend: 60 } }, trimmed: 1 });
    // What's shown as "before" is what was compared.
    expect(m.previous).toMatchObject({ from: d(-13), to: d(-8), spend: 60, linkClicks: 120, purchases: 6, imported: true });
    expect(m.deltas).toEqual({ spend: 0, linkClicks: 0, conversions: 0, purchases: 0, purchaseValue: 0, roas: 0 });
    expect(m.notCompared).toBeNull();
    expect(m.shareOfSales).toBe(0.07);
    expect(m.updatedAt).toBe("2026-10-19T11:00:00.000Z");
    expect(m.byProvider).toEqual([expect.objectContaining({ provider: "meta", spend: 70, current: expect.objectContaining({ spend: 70 }), accounts: ["a"] })]);
    expect(m.campaigns).toEqual([expect.objectContaining({ name: "Spring", spend: 70, complete: true })]);
  });

  it("never shows 0 for an account whose access ended or that was never read, and keeps a healthy platform's figures", () => {
    const meta = conn({ id: "m" });
    // Access ended on the 16th: nothing stored after it.
    const ended = conn({ id: "e", status: "reconnect", errorCode: "auth_expired", syncedThrough: d(-3) });
    // Connected a minute ago: its first sync hasn't finished.
    const google = conn({ id: "g", provider: "google", accountId: "123", historyFrom: null, syncedThrough: null, lastSyncedAt: null });
    const rows = [...daily(meta, d(-13), TODAY), ...daily(ended, d(-13), d(-3), { spend: 5 })];
    const m = adsFigures([meta, ended, google], rows, week())!;

    // Together: some account lacks days, and one has none at all, so no total and no part of one.
    expect(m.current).toBeNull();
    expect(m.partial).toBeNull();
    expect(m.coverage).toEqual({ from: null, through: null, complete: false });
    expect(m.compared).toBeNull();
    expect(m.notCompared).toBe("incomplete");
    expect(Object.values(m.deltas).every((v) => v === null)).toBe(true);
    expect(m.shareOfSales).toBeNull();
    expect(m.updatedAt).toBeNull();
    expect(m.series.every((s) => s.spend === null)).toBe(true);

    const [metaP, googleP] = m.byProvider;
    // Meta: both accounts have 13–16 Oct, so that part is known; the whole week isn't.
    expect(metaP).toMatchObject({ provider: "meta", spend: null, current: null, partial: { from: d(-6), to: d(-3), totals: { spend: 60 } }, notCompared: "incomplete" });
    expect(metaP!.coverage).toEqual({ from: d(-89), through: d(-3), complete: false });
    // Google: nothing yet. Its own entry says so; nothing reads as $0.
    expect(googleP).toMatchObject({ provider: "google", spend: null, current: null, partial: null, coverage: { from: null, through: null, complete: false }, notCompared: "incomplete", updatedAt: null });
    // Meta's days: known up to the 16th, then missing.
    const metaDays = m.seriesByProvider.find((s) => s.provider === "meta")!.series.map((s) => s.spend);
    expect(metaDays).toEqual([15, 15, 15, 15, null, null, null]);
    expect(m.seriesByProvider.find((s) => s.provider === "google")!.series.every((s) => s.spend === null)).toBe(true);

    // Each account says how far its figures reach.
    expect(m.accounts.map((a) => [a.id, a.coverage, a.coversRange])).toEqual([
      ["m", { from: d(-89), through: TODAY }, true],
      ["e", { from: d(-89), through: d(-3) }, false],
      ["g", { from: null, through: null }, false],
    ]);
    expect(m.accounts.find((a) => a.id === "e")).toMatchObject({ status: "reconnect", errorCode: "auth_expired" });
    // Its campaigns stop early: marked.
    expect(m.campaigns.map((c) => [c.accountId, c.complete])).toEqual([
      ["act_m", true],
      ["act_e", false],
    ]);

    // Dates the ended account still covered compare and add up as usual.
    const earlier = adsFigures([meta, ended], rows, week({ range: { from: d(-6), to: d(-4) }, previous: { from: d(-9), to: d(-7) } }))!;
    expect(earlier.current?.spend).toBe(45);
    expect(earlier.previous.spend).toBe(45);
    expect(earlier.deltas.spend).toBe(0);
  });

  it("gives what it holds of a year asked for, the days before its history missing, and no change before it", () => {
    const a = conn({ id: "a" });
    const rows = daily(a, d(-89), TODAY, { spend: 1 });
    const year = week({ range: { from: d(-365), to: TODAY }, previous: { from: d(-731), to: d(-366), until: "12:00:00" } });
    const m = adsFigures([a], rows, year)!;
    expect(m.series).toHaveLength(366);
    expect(m.series.filter((s) => s.spend === null)).toHaveLength(276);
    expect(m.series[275]!.spend).toBeNull();
    expect(m.series[276]).toMatchObject({ day: d(-89), spend: 1 });
    expect(m.current).toBeNull();
    expect(m.coverage).toEqual({ from: d(-89), through: TODAY, complete: false });
    expect(m.partial).toEqual({ from: d(-89), to: TODAY, totals: expect.objectContaining({ spend: 90 }) });
    expect(m.notCompared).toBe("no_history");
    expect(m.previous).toMatchObject({ spend: null, imported: false });
    expect(m.historyFrom).toBe(d(-89));
  });

  it("treats a day that hasn't started in the ad account's time zone as missing, and says which accounts follow another zone", () => {
    // 11:30 am on the 19th in Melbourne is 5:30 pm on the 18th in Los Angeles.
    const now = new Date("2026-10-19T00:30:00Z");
    const google = conn({ id: "g", provider: "google", accountId: "123", timezone: "America/Los_Angeles", syncedThrough: d(-1) });
    const meta = conn({ id: "m", timezone: "Australia/Sydney" });
    const rows = [...daily(google, d(-13), d(-1)), ...daily(meta, d(-13), TODAY)];
    const ask = (range: { from: string; to: string }, previous: { from: string; to: string; until?: string }) =>
      adsFigures([google, meta], rows, { range, previous, storeCurrency: "USD", storeTimeZone: "Australia/Melbourne", netSales: null, now })!;

    const today = ask({ from: TODAY, to: TODAY }, { from: d(-1), to: d(-1), until: "11:30:00" });
    expect(today.accounts.map((a) => [a.id, a.timezone, a.otherTimeZone, a.today, a.coversRange])).toEqual([
      ["g", "America/Los_Angeles", true, d(-1), false],
      ["m", "Australia/Sydney", false, TODAY, true],
    ]);
    // Google's 19th hasn't begun: unavailable, not $0. Meta's is there, so far.
    expect(today.current).toBeNull();
    const [g, m] = today.byProvider;
    expect(g).toMatchObject({ provider: "google", current: null, partial: null, notCompared: "running" });
    expect(m).toMatchObject({ provider: "meta", spend: 10, notCompared: "running" });
    expect(today.seriesByProvider.find((s) => s.provider === "google")!.series[0]!.spend).toBeNull();

    // Yesterday is still running in Los Angeles: Google's figure for it is so far, so no change for it.
    const yesterday = ask({ from: d(-1), to: d(-1) }, { from: d(-2), to: d(-2) });
    expect(yesterday.current).toMatchObject({ spend: 20 });
    expect(yesterday.notCompared).toBe("running");
    expect(yesterday.byProvider.find((p) => p.provider === "google")!.notCompared).toBe("running");
    expect(yesterday.byProvider.find((p) => p.provider === "meta")).toMatchObject({ notCompared: null, deltas: { spend: 0 } });
  });

  it("adds up only accounts in one currency, and lists the others as left out", () => {
    const usd = conn({ id: "u" });
    const eur = conn({ id: "x", currency: "EUR" });
    const rows = [...daily(usd, d(-6), TODAY), ...daily(eur, d(-6), TODAY, { spend: 999 })];
    const m = adsFigures([usd, eur], rows, week())!;
    expect(m.currency).toBe("USD");
    expect(m.current?.spend).toBe(70);
    expect(m.accounts.map((a) => [a.id, a.counted])).toEqual([
      ["u", true],
      ["x", false],
    ]);
    // A euro account that has never synced doesn't make the dollar figures unavailable.
    const fresh = conn({ id: "y", currency: "EUR", historyFrom: null, syncedThrough: null, lastSyncedAt: null });
    expect(adsFigures([usd, fresh], rows, week())!.current?.spend).toBe(70);
    // No account in the store's currency: the first known one's.
    expect(adsFigures([eur], rows, week())!).toMatchObject({ currency: "EUR", shareOfSales: null, current: { spend: 6993 } });
  });

  it("counts a closed account's days after it closed as the zeros they are", () => {
    const closed = conn({ id: "c", status: "unavailable", errorCode: "account_closed", accountStatus: "closed", syncedThrough: d(-20) });
    const m = adsFigures([closed], daily(closed, d(-30), d(-20)), week())!;
    expect(m.current).toMatchObject({ spend: 0 });
    expect(m.coverage.complete).toBe(true);
  });

  it("calls only purchases purchases: Google's every-action conversions stay conversions, and purchases not read yet are unknown", () => {
    const google = conn({ id: "g", provider: "google", accountId: "123" });
    const meta = conn({ id: "m" });
    const rows = [
      // Google's days from before purchases were read: 3 conversions (leads, calls...), purchases unknown.
      ...daily(google, d(-6), TODAY, { conversions: 3, conversionValue: 90, purchases: null, purchaseValue: null, linkClicks: 15 }),
      ...daily(meta, d(-6), TODAY),
    ];
    const m = adsFigures([google, meta], rows, week())!;
    const g = m.byProvider.find((p) => p.provider === "google")!;
    expect(g).toMatchObject({ conversions: 21, conversionValue: 630, purchases: null, purchaseValue: null, roas: null, costPerPurchase: null, linkClicks: 105, cpc: 0.67 });
    expect(m.byProvider.find((p) => p.provider === "meta")).toMatchObject({ purchases: 7, purchaseValue: 280, roas: 4 });
    // Together, the purchases aren't known while Google's are being read: never Meta's alone as the whole.
    expect(m.current).toMatchObject({ spend: 140, purchases: null, roas: null, linkClicks: 245 });
  });
});

describe("AdSense figures", () => {
  const sense = (over: Partial<AdConn> = {}) => conn({ id: "s", provider: "adsense", accountId: "pub-1", ...over });
  const day = (c: AdConn, site: string, dayStr: string, earnings: number): AdsenseDayRow & { connectionId: string } => ({
    connectionId: c.id,
    accountId: c.accountId,
    site,
    day: dayStr,
    earnings,
    pageViews: 100,
    impressions: 200,
    clicks: 2,
  });

  it("counts only the sites chosen for the store, lists the others, and sets only the store's earnings next to its sales", () => {
    const s = sense({ sites: ["shop.example.com"] });
    const rows = eachDay(d(-13), TODAY).flatMap((x) => [day(s, "shop.example.com", x, 2), day(s, "blog.example.com", x, 5)]);
    const m = adsenseFigures([s], rows, week())!;
    expect(m.current).toMatchObject({ earnings: 14, pageViews: 700 });
    expect(m.sites.map((x) => [x.site, x.earnings])).toEqual([["shop.example.com", 14]]);
    expect(m.sitesLeftOut.map((x) => [x.site, x.earnings])).toEqual([["blog.example.com", 35]]);
    expect(m.vsSales).toBe(0.014);
    expect(m.accounts[0]).toMatchObject({ provider: "adsense", sites: ["shop.example.com"] });
    // Through yesterday on both sides.
    expect(m.previous).toMatchObject({ from: d(-13), to: d(-8), earnings: 12, imported: true });
    expect(m.deltas.earnings).toBe(0);
    // No sites chosen: every site is the store's.
    expect(adsenseFigures([sense()], rows, week())!.current?.earnings).toBe(49);
  });

  it("shows days AdSense was never read, or not read since access ended, as missing rather than $0", () => {
    const s = sense({ status: "reconnect", errorCode: "auth_expired", syncedThrough: d(-2), historyFrom: d(-4) });
    const m = adsenseFigures([s], eachDay(d(-4), d(-2)).map((x) => day(s, "", x, 1)), week())!;
    expect(m.current).toBeNull();
    expect(m.vsSales).toBeNull();
    expect(m.partial).toEqual({ from: d(-4), to: d(-2), totals: expect.objectContaining({ earnings: 3 }) });
    expect(m.series.map((x) => x.earnings)).toEqual([null, null, 1, 1, 1, null, null]);
    expect(m.notCompared).toBe("no_history");
    expect(m.accounts[0]).toMatchObject({ coversRange: false, coverage: { from: d(-4), through: d(-2) } });
  });

  it("has no change for Today, which is still running", () => {
    const s = sense();
    const m = adsenseFigures([s], [day(s, "", TODAY, 3), day(s, "", d(-1), 9)], week({ range: { from: TODAY, to: TODAY }, previous: { from: d(-1), to: d(-1), until: "12:00:00" } }))!;
    expect(m.current?.earnings).toBe(3);
    expect(m.notCompared).toBe("running");
    expect(m.previous).toMatchObject({ from: null, to: null, earnings: null });
    expect(m.deltas.earnings).toBeNull();
  });
});
