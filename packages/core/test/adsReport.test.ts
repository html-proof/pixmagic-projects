import { describe, expect, it } from "vitest";
import { addDays, ADSENSE_FINALIZED_BY_DAY, adsenseFinalThrough, eachDay, type AdDayRow, type AdsenseDayRow } from "@app/shared";
import { recheckDays } from "../src/adConnections/sync.js";
import { adsenseFigures, adsFigures, daysToRead, type AdConn, type AdsAsk } from "../src/reports/ads.js";

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

/** "Last 7 days" on the 19th. */
const week = (over: Partial<AdsAsk> = {}): AdsAsk => ({
  range: { from: d(-6), to: TODAY },
  storeCurrency: "USD",
  storeTimeZone: "UTC",
  netSales: 1000,
  now: NOW,
  ...over,
});

describe("ad figures cover only the days the accounts have stored", () => {
  it("adds up an account that covers every day, the week alone: nothing of the week before", () => {
    const a = conn({ id: "a" });
    const rows = daily(a, d(-13), TODAY);
    const m = adsFigures([a], rows, week())!;
    expect(m.coverage).toEqual({ from: d(-89), through: TODAY, complete: true });
    expect(m.current).toMatchObject({ spend: 70, linkClicks: 140, purchases: 7, purchaseValue: 280, roas: 4 });
    expect(m.partial).toBeNull();
    // The rows of 6–12 Oct are given too, and count in nothing: no figure is set against other dates.
    for (const k of ["compared", "notCompared", "previous", "deltas", "imported"]) {
      expect(m).not.toHaveProperty(k);
      expect(m.byProvider[0]).not.toHaveProperty(k);
    }
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
    expect(m.shareOfSales).toBeNull();
    expect(m.updatedAt).toBeNull();
    expect(m.series.every((s) => s.spend === null)).toBe(true);

    const [metaP, googleP] = m.byProvider;
    // Meta: both accounts have 13–16 Oct, so that part is known; the whole week isn't. The ended
    // account's days won't come by themselves, so the part isn't shown as the week so far.
    expect(metaP).toMatchObject({ provider: "meta", spend: null, current: null, partial: { from: d(-6), to: d(-3), totals: { spend: 60 } }, soFar: null });
    expect(m.soFar).toBeNull();
    expect(metaP!.coverage).toEqual({ from: d(-89), through: d(-3), complete: false });
    // Google: nothing yet. Its own entry says so; nothing reads as $0.
    expect(googleP).toMatchObject({ provider: "google", spend: null, current: null, partial: null, coverage: { from: null, through: null, complete: false }, updatedAt: null });
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

    // Dates the ended account still covered add up as usual.
    const earlier = adsFigures([meta, ended], rows, week({ range: { from: d(-6), to: d(-4) } }))!;
    expect(earlier.current?.spend).toBe(45);
  });

  it("gives what it holds of a year asked for, the days before its history missing", () => {
    const a = conn({ id: "a" });
    const rows = daily(a, d(-89), TODAY, { spend: 1 });
    const year = week({ range: { from: d(-365), to: TODAY } });
    const m = adsFigures([a], rows, year)!;
    expect(m.series).toHaveLength(366);
    expect(m.series.filter((s) => s.spend === null)).toHaveLength(276);
    expect(m.series[275]!.spend).toBeNull();
    expect(m.series[276]).toMatchObject({ day: d(-89), spend: 1 });
    expect(m.current).toBeNull();
    expect(m.coverage).toEqual({ from: d(-89), through: TODAY, complete: false });
    expect(m.partial).toEqual({ from: d(-89), to: TODAY, totals: expect.objectContaining({ spend: 90 }) });
    expect(m.historyFrom).toBe(d(-89));
  });

  it("treats a day that hasn't started in the ad account's time zone as missing, and says which accounts follow another zone", () => {
    // 11:30 am on the 19th in Melbourne is 5:30 pm on the 18th in Los Angeles.
    const now = new Date("2026-10-19T00:30:00Z");
    const google = conn({ id: "g", provider: "google", accountId: "123", timezone: "America/Los_Angeles", syncedThrough: d(-1) });
    const meta = conn({ id: "m", timezone: "Australia/Sydney" });
    const rows = [...daily(google, d(-13), d(-1)), ...daily(meta, d(-13), TODAY)];
    const ask = (range: { from: string; to: string }) => adsFigures([google, meta], rows, { range, storeCurrency: "USD", storeTimeZone: "Australia/Melbourne", netSales: null, now })!;

    const today = ask({ from: TODAY, to: TODAY });
    expect(today.accounts.map((a) => [a.id, a.timezone, a.otherTimeZone, a.today, a.coversRange])).toEqual([
      ["g", "America/Los_Angeles", true, d(-1), false],
      ["m", "Australia/Sydney", false, TODAY, true],
    ]);
    // Google's 19th hasn't begun: unavailable, not $0. Meta's is there, so far.
    expect(today.current).toBeNull();
    const [g, m] = today.byProvider;
    expect(g).toMatchObject({ provider: "google", current: null, partial: null });
    expect(m).toMatchObject({ provider: "meta", spend: 10 });
    expect(today.seriesByProvider.find((s) => s.provider === "google")!.series[0]!.spend).toBeNull();

    // Yesterday is still running in Los Angeles: Google's figure for it is so far.
    const yesterday = ask({ from: d(-1), to: d(-1) });
    expect(yesterday.current).toMatchObject({ spend: 20 });
    expect(yesterday.byProvider.find((p) => p.provider === "meta")).toMatchObject({ spend: 10, current: { spend: 10 } });
  });

  it("shows the dates so far while the only days missing aren't over yet, and Unavailable for a real gap", () => {
    // 10 am on the 19th in Melbourne: 4 pm on the 18th in Los Angeles.
    const now = new Date("2026-10-18T23:00:00Z");
    const google = conn({ id: "g", provider: "google", accountId: "123", timezone: "America/Los_Angeles", syncedThrough: d(-1) });
    const rows = daily(google, d(-89), d(-1));
    const month = (c: AdConn[], over: Partial<AdsAsk> = {}) =>
      adsFigures(c, rows, { range: { from: d(-29), to: TODAY }, storeCurrency: "USD", storeTimeZone: "Australia/Melbourne", netSales: 1000, now, ...over })!;

    // The store's 19th hasn't begun in Los Angeles: everything up to now is there, through the 18th.
    const m = month([google]);
    expect(m.current).toBeNull();
    expect(m.soFar).toEqual({ from: d(-29), to: d(-1), totals: expect.objectContaining({ spend: 290 }) });
    expect(m.partial).toEqual(m.soFar);
    // Set against the store's sales up to now it would leave a day out: not given.
    expect(m.shareOfSales).toBeNull();
    expect(m.byProvider[0]).toMatchObject({ provider: "google", spend: null, soFar: { to: d(-1) } });
    expect(m.series.at(-1)).toMatchObject({ day: TODAY, spend: null });

    // Same zone, just after midnight, before the first sync of the day: through yesterday.
    const meta = conn({ id: "m", timezone: "Australia/Melbourne", syncedThrough: d(-1) });
    const early = adsFigures([meta], daily(meta, d(-13), d(-1)), week({ storeTimeZone: "Australia/Melbourne", now: new Date("2026-10-18T13:30:00Z") }))!;
    expect(early.soFar).toMatchObject({ from: d(-6), to: d(-1), totals: { spend: 60 } });

    // An account whose access ended: its missing days won't come, so Unavailable, even if it stopped only yesterday.
    expect(month([{ ...google, status: "reconnect", errorCode: "auth_expired" }]).soFar).toBeNull();
    // Its own running day (the 18th in Los Angeles) not stored yet: still only a day not over.
    expect(month([{ ...google, syncedThrough: d(-2) }]).soFar).toMatchObject({ to: d(-2) });
    // An active account a whole day behind: a gap, not a day still to come.
    expect(month([{ ...google, syncedThrough: d(-3) }]).soFar).toBeNull();
    // History that starts inside the dates: missing days at the start, never "so far".
    expect(month([{ ...google, historyFrom: d(-10) }]).soFar).toBeNull();
    // Today alone, not begun in Los Angeles: nothing to show yet.
    expect(month([google], { range: { from: TODAY, to: TODAY } })).toMatchObject({ current: null, partial: null, soFar: null });
    // Every day there: the whole range, as before.
    expect(month([{ ...google, timezone: "Australia/Melbourne", syncedThrough: TODAY }]).soFar).toBeNull();
  });

  it("reads the dates' days only, whichever platform's history reaches back before them", () => {
    // Google connected long ago, Meta ten days ago: "Last 90 days".
    const google = conn({ id: "g", provider: "google", accountId: "123", historyFrom: "2025-01-01" });
    const meta = conn({ id: "m", historyFrom: d(-9) });
    const ask = week({ range: { from: d(-89), to: TODAY } });
    // The 90 days before are stored for Google, and aren't read.
    expect(daysToRead([google, meta], ask)).toEqual({ ids: ["g", "m"], day: { gte: d(-89), lte: TODAY } });
    expect(daysToRead([meta], ask)).toEqual({ ids: ["m"], day: { gte: d(-89), lte: TODAY } });

    const rows = [...daily(google, d(-179), TODAY, { spend: 2 }), ...daily(meta, d(-9), TODAY)];
    const m = adsFigures([google, meta], rows, ask)!;
    const g = m.byProvider.find((p) => p.provider === "google")!;
    // Google's 90 days whole; Meta's start inside them, so its total and the two together aren't given.
    expect(g).toMatchObject({ spend: 180, current: { spend: 180 }, historyFrom: "2025-01-01" });
    expect(m.byProvider.find((p) => p.provider === "meta")).toMatchObject({ current: null, partial: { from: d(-9), to: TODAY, totals: { spend: 100 } }, historyFrom: d(-9) });
    expect(m).toMatchObject({ current: null, historyFrom: d(-9) });
    // The same answer whether or not the rows of the days before were handed over.
    expect(adsFigures([google, meta], rows.filter((r) => r.day >= d(-89)), ask)).toEqual(m);
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
    // The week before's earnings are in no figure.
    for (const k of ["compared", "notCompared", "previous", "deltas", "imported"]) expect(m).not.toHaveProperty(k);
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
    expect(m.accounts[0]).toMatchObject({ coversRange: false, coverage: { from: d(-4), through: d(-2) } });
  });

  it("never puts earnings AdSense didn't split by site down as another site's, or as the store's $0", () => {
    const s = sense({ sites: ["shop.example.com"] });
    // AdSense wouldn't split this account's report by site: one row a day, for every site together.
    const unsplit = eachDay(d(-13), TODAY).map((x) => day(s, "", x, 5));
    const m = adsenseFigures([s], unsplit, week())!;
    expect(m.current).toBeNull();
    expect(m.partial).toBeNull();
    expect(m.soFar).toBeNull();
    expect(m.vsSales).toBeNull();
    expect(m.sitesLeftOut).toEqual([]);
    expect(m.sites).toEqual([]);
    expect(m.series.every((x) => x.earnings === null)).toBe(true);
    expect(m.accounts[0]).toMatchObject({ unsplitThrough: TODAY, coverage: { from: null, through: null }, coversRange: false });

    // Split again from the 10th on (AdSense started reporting by site): the week is the store's site alone.
    const later = [...eachDay(d(-13), d(-10)).map((x) => day(s, "", x, 5)), ...eachDay(d(-9), TODAY).flatMap((x) => [day(s, "shop.example.com", x, 2), day(s, "blog.example.com", x, 3)])];
    const recovered = adsenseFigures([s], later, week())!;
    expect(recovered.current).toMatchObject({ earnings: 14 });
    expect(recovered.sitesLeftOut.map((x) => [x.site, x.earnings])).toEqual([["blog.example.com", 21]]);
    expect(recovered.accounts[0]).toMatchObject({ unsplitThrough: d(-10), coverage: { from: d(-9), through: TODAY }, coversRange: true });

    // No sites chosen: every site is the store's, split or not.
    expect(adsenseFigures([sense()], unsplit, week())!).toMatchObject({ current: { earnings: 35 }, sites: [{ site: "", earnings: 35 }], sitesLeftOut: [] });
    expect(adsenseFigures([sense()], unsplit, week())!.accounts[0]!.unsplitThrough).toBeNull();
  });

  it("gives Today, which is still running, as it stands", () => {
    const s = sense();
    const m = adsenseFigures([s], [day(s, "", TODAY, 3), day(s, "", d(-1), 9)], week({ range: { from: TODAY, to: TODAY } }))!;
    expect(m.current?.earnings).toBe(3);
    expect(m).not.toHaveProperty("previous");
  });

  describe("estimated or final", () => {
    const september = (over: Partial<AdsAsk> = {}) => week({ range: { from: "2026-09-01", to: "2026-09-30" }, ...over });

    it("calls a month final once AdSense finalized it and the sync read it again; this month's days stay estimated", () => {
      // Synced on the 19th: September, the month before, was re-read through the 10th.
      const s = sense();
      const rows = eachDay("2026-08-01", TODAY).map((x) => day(s, "", x, 1));
      const sept = adsenseFigures([s], rows, september())!;
      expect(sept).toMatchObject({ current: { earnings: 30 }, finalThrough: "2026-09-30", final: true });
      expect(sept.accounts[0]!.finalThrough).toBe("2026-09-30");
      const thisWeek = adsenseFigures([s], rows, week())!;
      expect(thisWeek).toMatchObject({ finalThrough: "2026-09-30", final: false });
      // On the 5th, September's figures are still being finalized: only August is final.
      const early = sense({ lastSyncedAt: new Date("2026-10-05T11:00:00Z") });
      expect(adsenseFigures([early], rows, september({ now: new Date("2026-10-05T12:00:00Z") }))!).toMatchObject({ finalThrough: "2026-08-31", final: false });
    });

    it("goes by the account's own day, and by the account whose figures are final the least far", () => {
      // 12:00 UTC on 10 Nov is already the 11th in Auckland: October is final there, not in UTC.
      const at = new Date("2026-11-10T12:00:00Z");
      const nz = sense({ id: "nz", timezone: "Pacific/Auckland", lastSyncedAt: at, historyFrom: "2026-08-01", syncedThrough: "2026-11-10" });
      const utc = sense({ id: "utc", lastSyncedAt: at, historyFrom: "2026-08-01", syncedThrough: "2026-11-10" });
      const october = { range: { from: "2026-10-01", to: "2026-10-31" }, now: at };
      const rows = (c: AdConn) => eachDay("2026-08-01", "2026-11-10").map((x) => day(c, "", x, 1));
      expect(adsenseFigures([nz], rows(nz), week(october))!).toMatchObject({ finalThrough: "2026-10-31", final: true });
      const both = adsenseFigures([nz, utc], [...rows(nz), ...rows(utc)], week(october))!;
      expect(both.accounts.map((a) => a.finalThrough)).toEqual(["2026-10-31", "2026-09-30"]);
      expect(both).toMatchObject({ current: { earnings: 62 }, finalThrough: "2026-09-30", final: false });
    });

    it("keeps an account whose syncs stopped as final only as it was when it last synced; never synced, nothing is final", () => {
      // Last synced on 25 Sep: September's figures were read before AdSense finalized them.
      const stopped = sense({ status: "error", errorCode: "temporary", lastSyncedAt: new Date("2026-09-25T11:00:00Z"), syncedThrough: "2026-09-25" });
      const m = adsenseFigures([stopped], eachDay(d(-89), "2026-09-25").map((x) => day(stopped, "", x, 1)), september({ range: { from: "2026-09-01", to: "2026-09-20" } }))!;
      expect(m).toMatchObject({ current: { earnings: 20 }, finalThrough: "2026-08-31", final: false });
      // The part every account covers is final or not as a whole.
      const partial = adsenseFigures([stopped], eachDay(d(-89), "2026-09-25").map((x) => day(stopped, "", x, 1)), week({ range: { from: "2026-08-20", to: "2026-09-30" } }))!;
      expect(partial).toMatchObject({ current: null, partial: { from: "2026-08-20", to: "2026-09-25" }, final: false });
      const fresh = sense({ lastSyncedAt: null, historyFrom: null, syncedThrough: null });
      expect(adsenseFigures([fresh], [], september())!).toMatchObject({ finalThrough: null, final: false });
      expect(adsenseFigures([fresh], [], september())!.accounts[0]!.finalThrough).toBeNull();
    });

    it("never lets a closed account, which isn't read again, hold later months back: its days since it closed are final zeros", () => {
      const live = sense({ id: "live", historyFrom: "2026-07-01" });
      // Closed on 20 Aug, last read that day: its August days stay AdSense's estimate, July's are final.
      const closed = sense({ id: "old", accountId: "pub-2", status: "unavailable", errorCode: "account_closed", accountStatus: "closed", lastSyncedAt: new Date("2026-08-20T11:00:00Z"), historyFrom: "2026-07-01", syncedThrough: "2026-08-20" });
      const rows = [...eachDay("2026-07-01", TODAY).map((x) => day(live, "", x, 1)), ...eachDay("2026-07-01", "2026-08-20").map((x) => day(closed, "", x, 1))];
      // September: the closed account's part is zeros, so the live account's finalized September is final.
      const sept = adsenseFigures([live, closed], rows, september())!;
      expect(sept).toMatchObject({ current: { earnings: 30 }, finalThrough: "2026-09-30", final: true });
      expect(sept.accounts.map((a) => a.finalThrough)).toEqual(["2026-09-30", "2026-07-31"]);
      // August holds its estimated days: estimated.
      const august = week({ range: { from: "2026-08-01", to: "2026-08-31" } });
      expect(adsenseFigures([live, closed], rows, august)!).toMatchObject({ current: { earnings: 51 }, finalThrough: "2026-07-31", final: false });
      // Closed once every day it stored was final (read again on 15 Sep, after August was finalized): final through its today.
      const settled = sense({ id: "old", accountId: "pub-2", status: "unavailable", errorCode: "account_closed", accountStatus: "closed", lastSyncedAt: new Date("2026-09-15T11:00:00Z"), historyFrom: "2026-07-01", syncedThrough: "2026-08-31" });
      const alone = adsenseFigures([settled], eachDay("2026-07-01", "2026-08-31").map((x) => day(settled, "", x, 1)), august)!;
      expect(alone).toMatchObject({ current: { earnings: 31 }, finalThrough: TODAY, final: true });
      expect(alone.accounts[0]!.finalThrough).toBe(TODAY);
    });

    it("calls the month before final only once the daily re-check has read it all again (recheckDays)", () => {
      const s = { provider: "adsense", timezone: "UTC" };
      // Through the 10th the re-check reaches back to the first of the month before, which isn't final yet...
      for (const x of eachDay("2026-11-01", `2026-11-${String(ADSENSE_FINALIZED_BY_DAY).padStart(2, "0")}`)) {
        expect(addDays(x, -(recheckDays(s, new Date(`${x}T12:00:00Z`)) - 1)) <= "2026-10-01").toBe(true);
        expect(adsenseFinalThrough(x)).toBe("2026-09-30");
      }
      // ...and from the 11th, when it counts as final, the re-check goes back to its 30 days.
      expect(adsenseFinalThrough("2026-11-11")).toBe("2026-10-31");
      expect(recheckDays(s, new Date("2026-11-11T12:00:00Z"))).toBe(30);
    });
  });
});

describe("a refresh someone asked for", () => {
  it("is on every account's view, with when the last sync started; an account without them says null", () => {
    const asked = new Date("2026-10-19T11:58:00Z");
    const tried = new Date("2026-10-19T11:59:00Z");
    const a = conn({ id: "a", syncRequestedAt: asked, lastSyncAttemptAt: tried });
    const b = conn({ id: "b" });
    const m = adsFigures([a, b], [...daily(a, d(-13), TODAY), ...daily(b, d(-13), TODAY)], week())!;
    expect(m.accounts[0]).toMatchObject({ syncRequestedAt: asked, lastSyncAttemptAt: tried, lastSyncedAt: new Date("2026-10-19T11:00:00Z") });
    expect(m.accounts[1]).toMatchObject({ syncRequestedAt: null, lastSyncAttemptAt: null });
    const s = conn({ id: "s", provider: "adsense", accountId: "pub-1", syncRequestedAt: asked });
    expect(adsenseFigures([s], [], week())!.accounts[0]).toMatchObject({ syncRequestedAt: asked, lastSyncAttemptAt: null });
  });
});

describe("the store's own sales next to the ad spend", () => {
  it("sets Shopify's net sales and orders against the spend, for the dates alone", () => {
    const meta = conn({ id: "m" });
    // Seven whole days, ended yesterday: $70 spent.
    const ended = week({ range: { from: d(-7), to: d(-1) }, netSales: 1400, orders: 70 });
    const m = adsFigures([meta], daily(meta, d(-14), d(-1)), ended)!;
    expect(m.sales).toEqual({ netSales: 1400, orders: 70, salesPerSpend: 20, shareOfSales: 0.05, costPerOrder: 1 });
    expect(m.shareOfSales).toBe(0.05);

    // Today in the range: the same, on what the week has so far.
    const running = adsFigures([meta], daily(meta, d(-13), TODAY), week({ orders: 60 }))!;
    expect(running.sales).toEqual({ netSales: 1000, orders: 60, salesPerSpend: 14.29, shareOfSales: 0.07, costPerOrder: 1.17 });

    // Not known, another currency, or days missing (no total to set them against): nothing.
    const rows = daily(meta, d(-13), TODAY);
    expect(adsFigures([meta], rows, week({ orders: null }))!.sales).toBeNull();
    expect(adsFigures([meta], rows, week({ netSales: null, orders: 5 }))!.sales).toBeNull();
    const eur = conn({ id: "e", currency: "EUR" });
    expect(adsFigures([eur], daily(eur, d(-13), TODAY), week({ orders: 5 }))!.sales).toBeNull();
    const short = conn({ id: "s", syncedThrough: d(-2) });
    expect(adsFigures([short], daily(short, d(-13), d(-2)), week({ orders: 5 }))!.sales).toBeNull();
  });

  it("counts the orders Shopify credits to each platform's ads, and the store's sales from them per unit of that platform's spend", () => {
    const meta = conn({ id: "m" });
    const google = conn({ id: "g", provider: "google" });
    const rows = [...daily(meta, d(-13), TODAY), ...daily(google, d(-13), TODAY, { spend: 5 })];
    const m = adsFigures([meta, google], rows, week({ sourced: [{ provider: "meta", orders: 3, sales: 210 }] }))!;
    // Meta spent $70 in the range, Google $35; Shopify credits nothing to Google's ads.
    expect(m.sourced).toEqual([
      { provider: "meta", orders: 3, sales: 210, salesPerSpend: 3 },
      { provider: "google", orders: 0, sales: 0, salesPerSpend: 0 },
    ]);
    // Not read: nothing. Another currency: the orders, but no ratio to the spend.
    expect(adsFigures([meta, google], rows, week())!.sourced).toBeNull();
    const eur = conn({ id: "e", currency: "EUR" });
    expect(adsFigures([eur], daily(eur, d(-13), TODAY), week({ sourced: [{ provider: "meta", orders: 2, sales: 50 }] }))!.sourced).toEqual([{ provider: "meta", orders: 2, sales: 50, salesPerSpend: null }]);
  });
});

describe("every campaign, for the campaign comparison", () => {
  it("lists every campaign of the dates, each with its own figures and nothing of the week before", () => {
    const meta = conn({ id: "m" });
    const google = conn({ id: "g", provider: "google", accountId: "111" });
    const rows = [
      // Spring ran both weeks: $10 a day, then $20 a day in the range.
      ...daily(meta, d(-13), d(-7)),
      ...daily(meta, d(-6), TODAY, { spend: 20, purchaseValue: 100 }),
      // Brand (Google) only started in the range.
      ...daily(google, d(-6), TODAY, { campaignId: "7", campaignName: "Brand", spend: 5 }),
      // Eleven small Meta campaigns: more than the dashboard's ten.
      ...Array.from({ length: 11 }, (_, i) => row(meta, d(-2), { campaignId: `s${i}`, campaignName: `Small ${i}`, spend: 1 })),
    ];
    const top = adsFigures([meta, google], rows, week())!;
    expect(top.campaigns).toHaveLength(10);
    expect(top.campaigns[0]).not.toHaveProperty("change");

    const all = adsFigures([meta, google], rows, week({ allCampaigns: true }))!;
    expect(all.campaigns).toHaveLength(13);
    // Spring's week: $20 a day. The $10 a day of the week before isn't in it.
    const spring = all.campaigns.find((c) => c.name === "Spring")!;
    expect(spring).toMatchObject({ spend: 140, purchaseValue: 700, complete: true });
    const brand = all.campaigns.find((c) => c.name === "Brand")!;
    expect(brand).toMatchObject({ provider: "google", spend: 35 });
    for (const c of all.campaigns) expect(c).not.toHaveProperty("change");
  });
});
