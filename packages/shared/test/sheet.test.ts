import { describe, expect, it } from "vitest";
import {
  businessEventInput,
  changeFrom,
  dayShown,
  eachDay,
  eventComparison,
  eventsOn,
  parseEventFilter,
  parseWeekdays,
  perDay,
  sheetColumns,
  sheetRows,
  sheetTotals,
  weekdaysParam,
  type BusinessEvent,
  type SheetDay,
  type SheetTotals,
} from "../src/index.js";

// September 2026: the 1st is a Tuesday, the 7th a Monday.
const day = (d: string, over: Partial<SheetDay> = {}): SheetDay => ({
  day: d,
  totalSales: 110,
  tax: 10,
  netSales: 90,
  orders: 3,
  orderValue: 95,
  newCustomerOrders: 2,
  units: 5,
  visits: 300,
  spend: { meta: 30, google: 10 },
  ...over,
});
const days = (from: string, to: string, over: (d: string) => Partial<SheetDay> = () => ({})) => eachDay(from, to).map((d) => day(d, over(d)));

const event = (id: string, startsOn: string, endsOn: string, kind: BusinessEvent["kind"] = "sale", title = id): BusinessEvent => ({
  id,
  title,
  kind,
  startsOn,
  endsOn,
  note: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

const value = (id: string, t: SheetTotals, rolling: SheetTotals | null = null, comparable = true) =>
  sheetRows({ comparable, grain: "day", providers: ["meta", "google"] })
    .find((r) => r.id === id)!
    .value(t, rolling);

describe("sheetTotals", () => {
  it("adds the days up in cents and works the ratios out from the totals", () => {
    const t = sheetTotals([day("2026-09-01", { netSales: 0.1, spend: { meta: 0.2, google: 0 } }), day("2026-09-02", { netSales: 0.2, spend: { meta: 0.1, google: 0 } })]);
    // 0.1 + 0.2 is 0.30000000000000004 in floating point; in cents it is 0.3.
    expect(t.netSales).toBe(0.3);
    expect(t.spend).toEqual({ meta: 0.3, google: 0 });
    expect(t.adSpend).toBe(0.3);
    expect(t).toMatchObject({ days: 2, orders: 6, units: 10, visits: 600, newCustomerOrders: 4, totalSales: 220, tax: 20, orderValue: 190 });
  });

  it("gives each row of the screenshot's sheet from one day", () => {
    const t = sheetTotals([day("2026-09-01")]);
    expect(value("total_sales", t)).toBe(110);
    expect(value("sales_ex_tax", t)).toBe(100);
    expect(value("tax_rate", t)).toBeCloseTo(0.1);
    expect(value("conversion_rate", t)).toBeCloseTo(0.01);
    expect(value("new_customer_share", t)).toBeCloseTo(2 / 3);
    expect(value("items_per_order", t)).toBeCloseTo(5 / 3);
    expect(value("aov", t)).toBeCloseTo(95 / 3);
    expect(value("sales_per_visit", t)).toBeCloseTo(0.3);
    expect(value("spend_per_visit", t)).toBeCloseTo(40 / 300);
    expect(value("spend_per_order", t)).toBeCloseTo(40 / 3);
    expect(value("spend_meta", t)).toBe(30);
    expect(value("ad_spend", t)).toBe(40);
    expect(value("ads_share", t)).toBeCloseTo(40 / 90);
    expect(value("mer", t)).toBeCloseTo(90 / 40);
    expect(value("after_ads", t)).toBe(50);
  });

  it("leaves a figure blank for a period one of whose days isn't known, never a part of it", () => {
    // Visits before the pixel counted them, and a day Google's account has no figures for.
    const t = sheetTotals([day("2026-09-01", { visits: null, spend: { meta: 30, google: null } }), day("2026-09-02")]);
    expect(t.visits).toBeNull();
    expect(t.spend).toEqual({ meta: 60, google: null });
    expect(t.adSpend).toBeNull();
    expect(value("conversion_rate", t)).toBeNull();
    expect(value("spend_meta", t)).toBe(60);
    expect(value("ads_share", t)).toBeNull();
    // What is known still is.
    expect(t.orders).toBe(6);
  });

  it("leaves out what the member doesn't see, and the ratios built on it", () => {
    const hidden = { totalSales: undefined, tax: undefined, newCustomerOrders: undefined };
    const t = sheetTotals([day("2026-09-01", hidden)]);
    expect(value("total_sales", t)).toBeUndefined();
    expect(value("tax_rate", t)).toBeUndefined();
    expect(value("new_customer_share", t)).toBeUndefined();
    expect(value("net_sales", t)).toBe(90);
  });

  it("gives no ratio when there is nothing to divide by", () => {
    const t = sheetTotals([day("2026-09-01", { orders: 0, visits: 0, netSales: 0, orderValue: 0, spend: { meta: 0, google: 0 } })]);
    expect(value("aov", t)).toBeNull();
    expect(value("conversion_rate", t)).toBeNull();
    expect(value("mer", t)).toBeNull();
    expect(value("ads_share", t)).toBeNull();
  });
});

describe("sheetRows", () => {
  it("sets spend against sales only when the dashboard would (same currency, no demo)", () => {
    const ids = (comparable: boolean) => sheetRows({ comparable, grain: "day", providers: ["meta"] }).map((r) => r.id);
    expect(ids(true)).toEqual(expect.arrayContaining(["spend_meta", "ads_share", "ads_share_3d", "mer", "after_ads", "spend_per_order"]));
    expect(ids(false)).toContain("spend_meta");
    expect(ids(false)).not.toEqual(expect.arrayContaining(["ads_share"]));
    expect(ids(false).filter((id) => ["ads_share", "ads_share_3d", "mer", "after_ads", "spend_per_order", "spend_per_visit"].includes(id))).toEqual([]);
    // One platform: its row is the total; two: a total line too.
    expect(ids(true)).not.toContain("ad_spend");
    expect(sheetRows({ comparable: true, grain: "day", providers: ["meta", "google"] }).map((r) => r.id)).toContain("ad_spend");
  });

  it("has the 3-day row on day columns only", () => {
    expect(sheetRows({ comparable: true, grain: "week", providers: ["meta"] }).map((r) => r.id)).not.toContain("ads_share_3d");
  });
});

describe("sheetColumns", () => {
  const sept = days("2026-09-01", "2026-09-30");

  it("makes a column a day, with the 3 days ending on it for the rolling share", () => {
    const cols = sheetColumns(days("2026-09-01", "2026-09-04", (d) => ({ netSales: d === "2026-09-03" ? 0 : 100, spend: { meta: 10 } })), [], "day", { weekdays: [], events: "all" });
    expect(cols.map((c) => c.key)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    // The first two days have no two days before them within the dates.
    expect(cols.map((c) => c.rolling?.days ?? null)).toEqual([null, null, 3, 3]);
    expect(value("ads_share_3d", cols[2]!.totals, cols[2]!.rolling)).toBeCloseTo(30 / 200);
    expect(value("ads_share_3d", cols[0]!.totals, cols[0]!.rolling)).toBeNull();
  });

  it("groups weeks Monday to Sunday and months by the calendar, within the dates", () => {
    const weeks = sheetColumns(sept, [], "week", { weekdays: [], events: "all" });
    // Tuesday 1 Sep starts in the week of Monday 31 Aug, cut to the dates.
    expect(weeks[0]).toMatchObject({ key: "2026-08-31", from: "2026-09-01", to: "2026-09-06", periodDays: 6, shownDays: 6 });
    expect(weeks[1]).toMatchObject({ key: "2026-09-07", from: "2026-09-07", to: "2026-09-13", periodDays: 7 });
    expect(weeks.at(-1)).toMatchObject({ key: "2026-09-28", to: "2026-09-30", periodDays: 3 });
    expect(weeks[1]!.totals.netSales).toBe(630);
    const months = sheetColumns(days("2026-08-30", "2026-09-02"), [], "month", { weekdays: [], events: "all" });
    expect(months.map((m) => [m.key, m.from, m.to, m.shownDays])).toEqual([
      ["2026-08", "2026-08-30", "2026-08-31", 2],
      ["2026-09", "2026-09-01", "2026-09-02", 2],
    ]);
  });

  it("shows only the weekdays picked, and says how many days of each period that is", () => {
    const weekends = sheetColumns(sept, [], "week", { weekdays: parseWeekdays("weekends"), events: "all" });
    expect(weekends[1]).toMatchObject({ key: "2026-09-07", periodDays: 7, shownDays: 2 });
    expect(weekends[1]!.totals.days).toBe(2);
    // Day columns: only Saturdays and Sundays.
    const cols = sheetColumns(sept, [], "day", { weekdays: [5, 6], events: "all" });
    expect(cols.map((c) => c.key).slice(0, 2)).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("filters days by the events on them, and lists each column's events", () => {
    const events = [event("bf", "2026-09-04", "2026-09-06", "sale", "Spring sale"), event("ad", "2026-09-05", "2026-09-05", "campaign", "Reels push")];
    const shown = (f: string) => sheetColumns(sept, events, "day", { weekdays: [], events: parseEventFilter(f) }).map((c) => c.key);
    expect(shown("with")).toEqual(["2026-09-04", "2026-09-05", "2026-09-06"]);
    expect(shown("kind:campaign")).toEqual(["2026-09-05"]);
    expect(shown("event:bf")).toEqual(["2026-09-04", "2026-09-05", "2026-09-06"]);
    expect(shown("event:gone")).toEqual([]);
    expect(shown("without")).toHaveLength(27);
    const cols = sheetColumns(sept, events, "week", { weekdays: [], events: "with" });
    expect(cols).toHaveLength(1);
    expect(cols[0]!.events.map((e) => e.id)).toEqual(["bf", "ad"]);
    expect(cols[0]!.shownDays).toBe(3);
  });
});

describe("filters in the address", () => {
  it("reads and writes the weekdays", () => {
    expect(parseWeekdays(null)).toEqual([]);
    expect(parseWeekdays("weekdays")).toEqual([0, 1, 2, 3, 4]);
    expect(parseWeekdays("4,0,9,x,4")).toEqual([0, 4]);
    expect(parseWeekdays("0,1,2,3,4,5,6")).toEqual([]);
    expect(weekdaysParam([4, 3, 2, 1, 0])).toBe("weekdays");
    expect(weekdaysParam([6, 5])).toBe("weekends");
    expect(weekdaysParam([2, 0])).toBe("0,2");
    expect(weekdaysParam([])).toBeNull();
  });

  it("reads the events filter, anything unknown as every day", () => {
    expect(parseEventFilter("with")).toBe("with");
    expect(parseEventFilter("kind:launch")).toBe("kind:launch");
    expect(parseEventFilter("kind:party")).toBe("all");
    expect(parseEventFilter("event:clx1abc")).toBe("event:clx1abc");
    expect(parseEventFilter("event:<script>")).toBe("all");
    expect(parseEventFilter(undefined)).toBe("all");
  });

  it("checks a day against both", () => {
    const events = [event("x", "2026-09-07", "2026-09-07")];
    expect(dayShown("2026-09-07", { weekdays: [0], events: "with" }, events)).toBe(true);
    expect(dayShown("2026-09-07", { weekdays: [1], events: "with" }, events)).toBe(false);
    expect(dayShown("2026-09-08", { weekdays: [], events: "with" }, events)).toBe(false);
  });
});

describe("eventComparison", () => {
  it("sets the event days against the others, and each event's own days", () => {
    const sept = days("2026-09-01", "2026-09-10", (d) => ({ netSales: d >= "2026-09-04" && d <= "2026-09-05" ? 300 : 100 }));
    const c = eventComparison(sept, [event("late", "2026-09-20", "2026-09-22"), event("bf", "2026-09-04", "2026-09-05"), event("early", "2026-08-30", "2026-09-01")]);
    // An event outside the dates is left out; one that started before them counts its days within them.
    expect(c.events.map((e) => [e.event.id, e.totals.days])).toEqual([
      ["early", 1],
      ["bf", 2],
    ]);
    expect(c.withEvents?.days).toBe(3);
    expect(c.withoutEvents?.days).toBe(7);
    const onDay = perDay(c.events[1]!.totals.netSales, c.events[1]!.totals);
    expect(onDay).toBe(300);
    expect(changeFrom(onDay, perDay(c.withoutEvents!.netSales, c.withoutEvents!))).toBe(2);
  });

  it("is empty with no days, and says so for a side with none", () => {
    expect(eventComparison([], [])).toEqual({ events: [], withEvents: null, withoutEvents: null });
    const c = eventComparison(days("2026-09-01", "2026-09-02"), []);
    expect(c.withEvents).toBeNull();
    expect(c.withoutEvents?.days).toBe(2);
  });
});

describe("business events", () => {
  it("takes an event whole, a day or a span", () => {
    expect(businessEventInput.parse({ title: " Spring sale ", kind: "sale", startsOn: "2026-09-04", endsOn: "2026-09-06", note: null })).toMatchObject({ title: "Spring sale" });
    const bad = (x: object) => businessEventInput.safeParse({ title: "x", kind: "sale", startsOn: "2026-09-04", endsOn: "2026-09-04", note: null, ...x }).success;
    expect(bad({})).toBe(true);
    expect(bad({ endsOn: "2026-09-03" })).toBe(false);
    expect(bad({ endsOn: "2027-09-05" })).toBe(false);
    expect(bad({ kind: "party" })).toBe(false);
    expect(bad({ title: "  " })).toBe(false);
    expect(bad({ startsOn: "2026-02-30", endsOn: "2026-03-01" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
  });

  it("lists the events on a day, earliest first", () => {
    const list = [event("b", "2026-09-03", "2026-09-03", "other", "B"), event("a", "2026-09-01", "2026-09-05", "sale", "A"), event("c", "2026-09-04", "2026-09-04")];
    expect(eventsOn(list, "2026-09-03").map((e) => e.id)).toEqual(["a", "b"]);
  });
});
