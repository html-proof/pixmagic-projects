import { describe, expect, it } from "vitest";
import {
  countsByStep,
  FUNNEL_ACTIONS,
  funnelDevice,
  funnelInsights,
  funnelTransitions,
  isFunnelAction,
  largestDropOff,
  productHandle,
  productStepsOf,
  productSuggestion,
  proportionZ,
  reachedCounts,
  segmentFunnel,
  significant,
  type InsightInput,
} from "../src/funnel.js";

describe("funnelDevice", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1", undefined, "mobile"],
    ["Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36", undefined, "mobile"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", undefined, "tablet"],
    ["Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1", undefined, "tablet"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36", undefined, "desktop"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15", undefined, "desktop"],
    ["SomeBot/1.0", undefined, "unknown"],
    ["SomeBrowser/1.0", "?1", "mobile"],
    ["", undefined, "unknown"],
  ])("%s → %s", (ua, hint, kind) => {
    expect(funnelDevice({ ua }, hint)).toBe(kind);
  });
});

describe("product pages", () => {
  it("reads the handle from product addresses only", () => {
    expect(productHandle("/products/Linen-Tee?variant=1")).toBe("linen-tee");
    expect(productHandle("/en-au/collections/shirts/products/linen-tee")).toBe("linen-tee");
    expect(productHandle("/collections/shirts")).toBeNull();
    expect(productHandle("/products/")).toBeNull();
    expect(productHandle(undefined)).toBeNull();
  });

  it("puts a view or an add on its product page, and nothing else", () => {
    expect(productStepsOf("product_viewed", "/products/tee")).toEqual({ handle: "tee", steps: 1 });
    // Added from its page: the page was seen too.
    expect(productStepsOf("product_added_to_cart", "/products/tee")).toEqual({ handle: "tee", steps: 3 });
    // A quick add from a collection names no product page.
    expect(productStepsOf("product_added_to_cart", "/collections/all")).toBeNull();
    expect(productStepsOf("page_viewed", "/products/tee")).toBeNull();
    expect(productStepsOf("product_viewed", undefined)).toBeNull();
  });
});

describe("steps and transitions", () => {
  // 1,000 visits: 600 stopped after visiting, 250 after a product, 75 after the cart, 25 at checkout, 50 bought.
  const at = [600, 250, 75, 25, 50];

  it("counts visits that reached each step or a later one", () => {
    expect(reachedCounts(at)).toEqual([1000, 400, 150, 75, 50]);
    expect(countsByStep([{ furthestStep: 4, visits: 2 }, { furthestStep: 0, visits: 3 }, { furthestStep: 9, visits: 1 }, { furthestStep: 0, visits: 1 }])).toEqual([4, 0, 0, 0, 3]);
  });

  it("works out progression, drop-off and visits lost between each pair of steps", () => {
    const t = funnelTransitions(reachedCounts(at));
    expect(t.map((x) => [x.from, x.to, x.fromCount, x.toCount, x.lost])).toEqual([
      ["visited", "viewed_product", 1000, 400, 600],
      ["viewed_product", "added_to_cart", 400, 150, 250],
      ["added_to_cart", "started_checkout", 150, 75, 75],
      ["started_checkout", "purchased", 75, 50, 25],
    ]);
    expect(t.map((x) => x.progression)).toEqual([0.4, 0.375, 0.5, 50 / 75]);
    expect(t[0]!.dropOff).toBeCloseTo(0.6, 10);
    expect(t.every((x) => x.previous === null && x.change === null && !x.significant)).toBe(true);
    expect(largestDropOff(t)).toBe(0);
  });

  it("has no rate without visits, and no largest drop-off when nobody left", () => {
    const t = funnelTransitions([0, 0, 0, 0, 0]);
    expect(t.every((x) => x.progression === null && x.dropOff === null)).toBe(true);
    expect(largestDropOff(t)).toBeNull();
    expect(largestDropOff(funnelTransitions([5, 5, 5, 5, 5]))).toBeNull();
  });

  it("compares each transition with the dates compared with, and says when the change is more than chance", () => {
    const now = reachedCounts(at);
    const before = [1000, 400, 150, 105, 70];
    const t = funnelTransitions(now, before);
    expect(t[0]).toMatchObject({ previous: { fromCount: 1000, toCount: 400, progression: 0.4 }, change: 0, significant: false });
    // Cart → checkout: 50% now against 70% before, on 150 carts each.
    expect(t[2]!.change).toBeCloseTo(-0.2, 10);
    expect(t[2]!.significant).toBe(true);
    // Checkout → purchase: 66.7% both times.
    expect(t[3]!.significant).toBe(false);
  });

  it("summarizes one segment's funnel", () => {
    expect(segmentFunnel("mobile", at)).toEqual({
      key: "mobile",
      visits: 1000,
      reached: [1000, 400, 150, 75, 50],
      progression: [0.4, 0.375, 0.5, 50 / 75],
      conversionRate: 0.05,
      checkoutCompletion: 50 / 75,
    });
    expect(segmentFunnel("empty", [0, 0, 0, 0, 0])).toMatchObject({ visits: 0, conversionRate: null, checkoutCompletion: null, progression: [null, null, null, null] });
  });
});

describe("proportionZ", () => {
  it("matches the pooled two-proportion test", () => {
    // 50% of 150 against 70% of 150: p = 0.6, se = sqrt(0.24 * 2/150) = 0.0566 → z = -3.54.
    expect(proportionZ(75, 150, 105, 150)).toBeCloseTo(-3.5355, 3);
    expect(significant(proportionZ(75, 150, 105, 150))).toBe(true);
    expect(significant(proportionZ(52, 100, 48, 100))).toBe(false);
  });

  it("won't judge groups too small or too lopsided to test", () => {
    expect(proportionZ(5, 20, 15, 20)).toBeNull();
    expect(proportionZ(1, 500, 0, 500)).toBeNull();
    expect(proportionZ(0, 0, 0, 0)).toBeNull();
    expect(significant(null)).toBe(false);
  });
});

describe("funnelInsights", () => {
  const base: InsightInput = { reached: [1000, 400, 150, 75, 50], previousReached: null, sameLength: true, devices: [], visitors: [], products: [] };

  it("always leads with the largest drop-off once there are enough visits", () => {
    expect(funnelInsights(base)).toEqual([{ kind: "largest_drop", tone: "neutral", from: "visited", to: "viewed_product", lost: 600, dropOff: 0.6, fromCount: 1000 }]);
    expect(funnelInsights({ ...base, reached: [20, 10, 5, 2, 1] })).toEqual([]);
  });

  it("reports changes against the dates compared with only when they are more than chance", () => {
    // Visits 1,000 against 700 (same length); cart → checkout 50% against 70% (74 of 105); the other steps as before.
    const before = [700, 280, 105, 74, 49];
    const found = funnelInsights({ ...base, previousReached: before });
    expect(found.map((i) => i.kind)).toEqual(expect.arrayContaining(["largest_drop", "visits", "transition"]));
    expect(found.find((i) => i.kind === "visits")).toMatchObject({ tone: "positive", current: 1000, previous: 700 });
    const transitions = found.filter((i) => i.kind === "transition");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "added_to_cart", to: "started_checkout", tone: "negative", current: 0.5, fromCount: 150, previousFromCount: 105 });
    // 5% against 7% of visits bought: within chance on these numbers.
    expect(found.some((i) => i.kind === "conversion")).toBe(false);
    // The same numbers over a period of another length: no visit count is compared.
    expect(funnelInsights({ ...base, previousReached: before, sameLength: false }).map((i) => i.kind)).not.toContain("visits");
    // A small wobble says nothing.
    expect(funnelInsights({ ...base, previousReached: [990, 398, 151, 76, 49] }).map((i) => i.kind)).toEqual(["largest_drop"]);
  });

  it("compares mobile with desktop, and new with returning visitors", () => {
    const devices = [segmentFunnel("mobile", [700, 200, 60, 30, 10]), segmentFunnel("desktop", [200, 100, 40, 20, 40])];
    const gap = funnelInsights({ ...base, devices }).find((i) => i.kind === "segment_gap");
    expect(gap).toMatchObject({ dimension: "device", metric: "conversion", better: "desktop", worse: "mobile", betterOf: 400, worseOf: 1000 });
    expect(gap && gap.kind === "segment_gap" && gap.betterRate).toBeCloseTo(0.1, 10);
    // Too few desktop visits to say anything.
    expect(funnelInsights({ ...base, devices: [devices[0]!, segmentFunnel("desktop", [10, 5, 3, 1, 1])] }).some((i) => i.kind === "segment_gap")).toBe(false);
  });

  it("points out a much-viewed product page that is rarely added to cart", () => {
    const products = [
      { handle: "tee", title: "Tee", viewed: 300, added: 9 },
      { handle: "mug", title: "Mug", viewed: 300, added: 60 },
      { handle: "cap", title: null, viewed: 200, added: 40 },
    ];
    const found = funnelInsights({ ...base, products }).filter((i) => i.kind === "product_interest");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ handle: "tee", viewed: 300, added: 9, rate: 0.03, othersRate: 0.2 });
  });

  it("shows at most six", () => {
    const devices = [segmentFunnel("mobile", [700, 200, 60, 30, 10]), segmentFunnel("desktop", [200, 100, 40, 20, 40])];
    const visitors = [segmentFunnel("new", [800, 250, 80, 40, 10]), segmentFunnel("returning", [100, 50, 20, 10, 20])];
    const products = [{ handle: "tee", title: "Tee", viewed: 300, added: 9 }, { handle: "mug", title: "Mug", viewed: 300, added: 60 }, { handle: "hat", title: "Hat", viewed: 300, added: 10 }];
    expect(funnelInsights({ ...base, previousReached: [700, 400, 100, 30, 10], devices, visitors, products }).length).toBeLessThanOrEqual(6);
  });
});

describe("FUNNEL_ACTIONS", () => {
  it("has unique ids for every step", () => {
    expect(new Set(FUNNEL_ACTIONS.map((a) => a.id)).size).toBe(FUNNEL_ACTIONS.length);
    expect(new Set(FUNNEL_ACTIONS.map((a) => a.step))).toEqual(new Set(["visited", "viewed_product", "added_to_cart", "started_checkout", "purchased"]));
    expect(isFunnelAction("cart.usability")).toBe(true);
    expect(isFunnelAction("made.up")).toBe(false);
  });
});

describe("productSuggestion", () => {
  const others = { viewed: 1000, added: 200, landed: 400, landedLeft: 120 };
  const none = { landed: 0, landedLeft: 0 };
  it("suggests the page when many look and few add", () => {
    expect(productSuggestion({ viewed: 100, added: 3, ...none }, others)).toBe("review_page");
    // Too few views to judge.
    expect(productSuggestion({ viewed: 10, added: 0, ...none }, others)).toBeNull();
    expect(productSuggestion({ viewed: 100, added: 20, ...none }, others)).toBeNull();
  });

  it("suggests checkout when it is added but nobody ordered it, only with sales to hand", () => {
    expect(productSuggestion({ viewed: 40, added: 12, ...none, orders: 0 }, others)).toBe("check_checkout");
    expect(productSuggestion({ viewed: 40, added: 12, ...none }, others)).toBeNull();
    expect(productSuggestion({ viewed: 40, added: 12, ...none, orders: 1 }, others)).toBeNull();
  });

  it("notes a landing page visits leave from more than the store's other product pages", () => {
    // 28 of 40 landing visits left from it (70%), against 30% elsewhere.
    expect(productSuggestion({ viewed: 60, added: 12, landed: 40, landedLeft: 28 }, others)).toBe("landing_exits");
    // 14 of 40 (35%): in line with the rest.
    expect(productSuggestion({ viewed: 60, added: 12, landed: 40, landedLeft: 14 }, others)).toBeNull();
  });

  it("notes sales no tracked visit led to", () => {
    expect(productSuggestion({ viewed: 0, added: 0, ...none, orders: 3 }, others)).toBe("sold_untracked");
    // Views not recorded for these dates: nothing to say about them.
    expect(productSuggestion({ viewed: null, added: null, ...none, orders: 3 }, others)).toBeNull();
  });
});
