import { describe, expect, it } from "vitest";
import { bestEntryPage, biggestDropOff, cleanPath, dropOffSection, foldVisit, sectionBit, summarizeJourney, type FunnelStepSummary, type JourneyPageRow } from "../src/journey.js";

describe("cleanPath", () => {
  it.each([
    ["/", "home", "/"],
    ["/fr", "home", "/"],
    ["/en-au/", "home", "/"],
    ["/en-au/products/Linen-Shirt?variant=1#reviews", "product", "/products/linen-shirt"],
    ["/collections/shirts/products/linen-shirt", "product", "/products/linen-shirt"],
    ["/products/caf%C3%A9-mug", "product", "/products/café-mug"],
    ["/collections/all", "collection", "/collections/all"],
    ["/collections/", "collection", "/collections"],
    ["/search?q=scarf", "search", "/search"],
    ["/cart", "cart", "/cart"],
    ["/cart/c/Z2NwLXVz?key=abc", "cart", "/cart"],
    ["/checkouts/cn/Z2NwLWV1cm9wZS13ZXN0/information", "checkout", "/checkout"],
    ["/checkout", "checkout", "/checkout"],
    ["/66270429390/orders/0b3c6f0e8d1e2f/authenticate?key=x", "checkout", "/checkout"],
    ["/account/orders/1234567", "account", "/account"],
    ["/pages/about-us", "content", "/pages/about-us"],
    ["/blogs/news/spring-drop", "content", "/blogs/news/spring-drop"],
    ["/policies/refund-policy", "content", "/policies/refund-policy"],
    ["/apps/reviews", "other", "/apps/reviews"],
    ["//double//slash/", "other", "/double/slash"],
  ])("%s → %s %s", (raw, section, path) => {
    expect(cleanPath(raw)).toEqual({ section, path });
  });

  it("never keeps checkout or order tokens", () => {
    for (const p of ["/checkouts/cn/SECRET/thank-you", "/123/checkouts/SECRET/thank_you", "/account/addresses/SECRET"]) {
      expect(cleanPath(p).path).not.toContain("secret");
    }
  });

  it("caps very long paths", () => {
    expect(cleanPath(`/pages/${"x".repeat(500)}`).path.length).toBe(200);
  });
});

describe("foldVisit", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 10, min));

  it("takes the earliest page as the entry and the latest as the exit, in any order", () => {
    const d = foldVisit([
      { name: "product_added_to_cart", timestamp: at(9), path: "/products/tee" },
      { name: "page_viewed", timestamp: at(5), path: "/collections/tees" },
      { name: "page_viewed", timestamp: at(1), path: "/" },
      { name: "page_viewed", timestamp: at(12), path: "/cart" },
      { name: "product_viewed", timestamp: at(8), path: "/products/tee" },
    ]);
    expect(d).toMatchObject({
      enteredAt: at(1),
      entrySection: "home",
      entryPath: "/",
      exitedAt: at(12),
      exitSection: "cart",
      exitPath: "/cart",
      furthestStep: 2,
      pageViews: 3,
    });
    expect(d.sections).toBe(sectionBit("home") | sectionBit("collection") | sectionBit("product") | sectionBit("cart"));
  });

  it("places checkout and product events even without a path (older pixels)", () => {
    const d = foldVisit([
      { name: "page_viewed", timestamp: at(1) },
      { name: "product_viewed", timestamp: at(2) },
      { name: "checkout_completed", timestamp: at(3) },
    ]);
    expect(d).toMatchObject({ entrySection: "product", entryPath: null, exitSection: "checkout", exitPath: "/checkout", furthestStep: 4, pageViews: 1 });
  });
});

describe("summarizeJourney", () => {
  const s = summarizeJourney(
    [
      { furthestStep: 0, exitSection: "home", visits: 50, pageViews: 60 },
      { furthestStep: 0, exitSection: "collection", visits: 20, pageViews: 40 },
      { furthestStep: 1, exitSection: "product", visits: 15, pageViews: 45 },
      { furthestStep: 2, exitSection: "cart", visits: 6, pageViews: 30 },
      { furthestStep: 2, exitSection: null, visits: 1, pageViews: 3 },
      { furthestStep: 3, exitSection: "checkout", visits: 4, pageViews: 24 },
      { furthestStep: 4, exitSection: "checkout", visits: 4, pageViews: 28 },
    ],
    [
      { section: "home", visits: 80, entries: 60 },
      { section: "collection", visits: 45, entries: 15 },
      { section: "product", visits: 30, entries: 25 },
      { section: "cart", visits: 11, entries: 0 },
      { section: "checkout", visits: 8, entries: 0 },
    ],
  );

  it("counts each step as visits that got at least that far", () => {
    expect(s.visits).toBe(100);
    expect(s.purchases).toBe(4);
    expect(s.conversionRate).toBe(0.04);
    expect(s.exits).toBe(96);
    expect(s.pagesPerVisit).toBe(2.3);
    expect(s.steps.map((x) => x.reached)).toEqual([100, 30, 15, 8, 4]);
    expect(s.steps.map((x) => x.left)).toEqual([70, 15, 7, 4, 0]);
    expect(s.steps.map((x) => x.continued)).toEqual([30, 15, 8, 4, null]);
    expect(s.steps[0]!.leftRate).toBe(0.7);
    expect(s.steps[4]!.leftRate).toBeNull();
  });

  it("says where the people who stopped at each step left from", () => {
    expect(s.steps[0]!.leftFrom).toEqual([
      { section: "home", visits: 50 },
      { section: "collection", visits: 20 },
    ]);
    expect(s.steps[2]!.leftFrom).toEqual([
      { section: "cart", visits: 6 },
      { section: null, visits: 1 },
    ]);
    expect(s.steps[4]!.leftFrom).toEqual([]);
  });

  it("gives each section its visits, landings and exits without buying", () => {
    expect(s.sections.map((x) => x.section)).toEqual(["home", "collection", "product", "cart", "checkout"]);
    expect(s.sections[0]).toEqual({ section: "home", visits: 80, entries: 60, exits: 50, exitRate: 0.625 });
    // Purchases are not exits: only the 4 who started checkout and stopped.
    expect(s.sections.find((x) => x.section === "checkout")).toMatchObject({ exits: 4, exitRate: 0.5 });
  });

  it("is all zeros and nulls with no data", () => {
    const e = summarizeJourney([], []);
    expect(e).toMatchObject({ visits: 0, purchases: 0, conversionRate: null, pagesPerVisit: null, sections: [] });
    expect(e.steps.every((x) => x.reached === 0 && x.shareOfVisits === null)).toBe(true);
  });
});

describe("reading the summary", () => {
  const step = (step: FunnelStepSummary["step"], left: number, leftFrom: FunnelStepSummary["leftFrom"] = []): FunnelStepSummary => ({
    step,
    reached: 0,
    shareOfVisits: null,
    continued: null,
    left,
    leftRate: null,
    leftFrom,
  });

  it("finds the step most visits stopped at, never the purchase", () => {
    const steps = [step("visited", 10), step("viewed_product", 40), step("added_to_cart", 5), step("started_checkout", 2), step("purchased", 0)];
    expect(biggestDropOff(steps)?.step).toBe("viewed_product");
    // The purchase step is left out even if it somehow carried leavers.
    expect(biggestDropOff([step("visited", 1), step("purchased", 99)])?.step).toBe("visited");
  });

  it("keeps the earlier step on a tie, including when nobody left", () => {
    expect(biggestDropOff([step("visited", 7), step("viewed_product", 7), step("purchased", 0)])?.step).toBe("visited");
    expect(biggestDropOff([step("visited", 0), step("viewed_product", 0), step("purchased", 0)])).toMatchObject({ step: "visited", left: 0 });
  });

  it("has no drop-off with fewer than two steps", () => {
    expect(biggestDropOff([])).toBeNull();
    expect(biggestDropOff([step("visited", 9)])).toBeNull();
  });

  it("names the first recorded section the leavers were on", () => {
    expect(dropOffSection(step("viewed_product", 5, [{ section: null, visits: 9 }, { section: "product", visits: 4 }, { section: "cart", visits: 1 }]))).toBe("product");
    expect(dropOffSection(step("viewed_product", 5, [{ section: null, visits: 5 }]))).toBeUndefined();
    expect(dropOffSection(step("viewed_product", 0))).toBeUndefined();
    expect(dropOffSection(null)).toBeUndefined();
    expect(dropOffSection(undefined)).toBeUndefined();
  });

  const page = (path: string, visits: number, purchases: number): JourneyPageRow => ({ path, section: "other", visits, purchases });

  it("picks the landing page that bought most often, from 5 visits up", () => {
    const pages = [page("/", 100, 3), page("/products/mug", 5, 1), page("/collections/all", 4, 4), page("/blogs/news", 20, 2)];
    expect(bestEntryPage(pages)?.path).toBe("/products/mug");
    // Under 5 visits is too few to say anything, however well it converted.
    expect(bestEntryPage([page("/a", 4, 4)])).toBeUndefined();
    expect(bestEntryPage([])).toBeUndefined();
  });

  it("keeps the first listed page on a tie and doesn't reorder its input", () => {
    const pages = [page("/a", 10, 1), page("/b", 20, 2), page("/c", 10, 0)];
    expect(bestEntryPage(pages)?.path).toBe("/a");
    expect(pages.map((p) => p.path)).toEqual(["/a", "/b", "/c"]);
  });

  it("returns a page that nobody bought from when none did (callers check purchases)", () => {
    expect(bestEntryPage([page("/a", 10, 0), page("/b", 8, 0)])?.path).toBe("/a");
  });
});
