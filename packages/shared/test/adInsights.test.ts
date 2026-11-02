import { describe, expect, it } from "vitest";
import { advertisingInsights, type AdInsightInput } from "../src/adInsights";

const f = { money: (n: number) => `$${n.toFixed(2)}`, unit: "$1", pct: (n: number) => `${(n * 100).toFixed(1)}%`, times: (n: number) => `${n.toFixed(2)}×` };

const meta = { provider: "meta" as const, spend: 7620, purchases: 3120, purchaseValue: 32918.4, roas: 4.32 };
const google = { provider: "google" as const, spend: 5230, purchases: 1120, purchaseValue: 18043.5, roas: 3.45 };
const base: AdInsightInput = {
  platforms: [meta, google],
  totals: { spend: 12850, purchases: 4240, purchaseValue: 50961.9, roas: 3.97 },
  deltas: { spend: 0.125, purchases: 0.224, purchaseValue: 0.287 },
  versus: "vs 1 – 30 Sep",
  margin: null,
};

describe("the Advertising overview's key insights", () => {
  it("says what changed, which platform returns the most and where the money went, all as each platform's own count", () => {
    const ids = advertisingInsights(base, f, 10).map((i) => i.id);
    expect(ids).toEqual(["value_change", "best_roas", "share", "roas_meaning"]);
    const text = advertisingInsights(base, f, 10).map((i) => i.text);
    expect(text[0]).toBe("The purchase value your platforms credit to their ads is up 28.7% vs 1 – 30 Sep.");
    expect(text[1]).toBe("Meta Ads returns the most per $1 spent: 4.32×, against 3.45× for Google Ads, each by its own count.");
    expect(text[2]).toBe("Meta Ads took 59.3% of your ad spend.");
    expect(text[3]).toContain("isn't profit");
  });

  it("warns when spend rises while purchases fall, and when a platform credits less than it cost", () => {
    const got = advertisingInsights({ ...base, platforms: [{ ...google, roas: 0.8 }], deltas: { spend: 0.2, purchases: -0.1, purchaseValue: -0.05 } }, f, 10);
    expect(got.map((i) => [i.id, i.tone])).toEqual([
      ["below_one", "bad"],
      ["spend_outpaces", "warn"],
      ["roas_meaning", "info"],
    ]);
    expect(got[1]!.text).toBe("Ad spend is up 20.0% vs 1 – 30 Sep while the platforms counted 10.0% fewer purchases.");
  });

  it("says what ROAS pays for the products at Shopify's margin, and whether the platforms' figure reaches it", () => {
    const pays = advertisingInsights({ ...base, margin: 0.5 }, f, 10).find((i) => i.id === "break_even")!;
    expect(pays.tone).toBe("good");
    expect(pays.text).toContain("above a ROAS of 2.00×: yours is 3.97×.");
    const short = advertisingInsights({ ...base, margin: 0.2 }, f, 10).find((i) => i.id === "break_even")!;
    expect(short.tone).toBe("warn");
    expect(short.text).toContain("5.00×");
    // Never with the demo's simulated spend, nor without a margin.
    expect(advertisingInsights({ ...base, margin: 0.5, demo: true }, f, 10).some((i) => i.id === "break_even")).toBe(false);
  });

  it("points to tracking when spend brought no purchase, and says nothing it can't know", () => {
    const none = advertisingInsights({ platforms: [{ ...meta, purchases: 0, purchaseValue: 0, roas: 0 }], totals: { spend: 100, purchases: 0, purchaseValue: 0, roas: 0 }, deltas: null, versus: null, margin: 0.4 }, f, 10);
    expect(none.map((i) => i.id)).toEqual(["no_purchases"]);
    // Purchases not read yet, nothing compared: nothing to say.
    expect(advertisingInsights({ platforms: [{ ...meta, purchases: null, roas: null }], totals: { spend: 100, purchases: null, purchaseValue: null, roas: null }, deltas: null, versus: null, margin: null }, f)).toEqual([]);
    // A small change isn't news.
    expect(advertisingInsights({ ...base, deltas: { spend: 0.01, purchases: 0.01, purchaseValue: 0.02 } }, f, 10).some((i) => i.id === "value_change")).toBe(false);
  });

  it("keeps to the limit, most telling first", () => {
    expect(advertisingInsights(base, f).length).toBe(4);
    expect(advertisingInsights(base, f, 2).map((i) => i.id)).toEqual(["value_change", "best_roas"]);
  });
});
