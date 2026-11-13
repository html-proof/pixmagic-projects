import { describe, expect, it } from "vitest";
import { advertisingInsights, type AdInsightInput } from "../src/adInsights";

const f = { money: (n: number) => `$${n.toFixed(2)}`, unit: "$1", pct: (n: number) => `${(n * 100).toFixed(1)}%`, times: (n: number) => `${n.toFixed(2)}×` };

const meta = { provider: "meta" as const, spend: 7620, purchases: 3120, purchaseValue: 32918.4, roas: 4.32 };
const google = { provider: "google" as const, spend: 5230, purchases: 1120, purchaseValue: 18043.5, roas: 3.45 };
/** One platform counted: the module's totals are its own figures. */
const one: AdInsightInput = {
  platforms: [meta],
  totals: { spend: 7620, purchases: 3120, purchaseValue: 32918.4, roas: 4.32 },
  margin: null,
};
/** Meta and Google both counted: the totals' purchases add up two claims that can overlap. */
const both: AdInsightInput = {
  platforms: [meta, google],
  totals: { spend: 12850, purchases: 4240, purchaseValue: 50961.9, roas: 3.97 },
  margin: null,
  claimsAddUp: false,
};

describe("the Advertising overview's key insights", () => {
  it("with one platform, says what its ROAS means, as the platform's own count", () => {
    const got = advertisingInsights(one, f, 10);
    expect(got.map((i) => i.id)).toEqual(["roas_meaning"]);
    expect(got[0]!.text).toBe("A ROAS of 4.32× means the platforms credit $4.32 of purchases to every $1 spent: before product costs, fees and your other costs, so it isn't profit.");
  });

  it("warns when a platform credits less than it cost", () => {
    const got = advertisingInsights({ ...one, platforms: [{ ...google, roas: 0.8 }] }, f, 10);
    expect(got.map((i) => [i.id, i.tone])).toEqual([
      ["below_one", "bad"],
      ["roas_meaning", "info"],
    ]);
    expect(got[0]!.text).toBe("Google Ads credits less in purchases than it cost: a ROAS of 0.80×, by its own count.");
  });

  it("says what ROAS pays for the products at Shopify's margin, and whether the platform's figure reaches it", () => {
    const pays = advertisingInsights({ ...one, margin: 0.5 }, f, 10).find((i) => i.id === "break_even")!;
    expect(pays.tone).toBe("good");
    expect(pays.text).toContain("above a ROAS of 2.00×: yours is 4.32×.");
    const short = advertisingInsights({ ...one, margin: 0.2 }, f, 10).find((i) => i.id === "break_even")!;
    expect(short.tone).toBe("warn");
    expect(short.text).toContain("5.00×");
    // Never with the demo's simulated spend, nor without a margin.
    expect(advertisingInsights({ ...one, margin: 0.5, demo: true }, f, 10).some((i) => i.id === "break_even")).toBe(false);
  });

  it("points to tracking when spend brought no purchase, and says nothing it can't know", () => {
    const none = advertisingInsights({ platforms: [{ ...meta, purchases: 0, purchaseValue: 0, roas: 0 }], totals: { spend: 100, purchases: 0, purchaseValue: 0, roas: 0 }, margin: 0.4 }, f, 10);
    expect(none.map((i) => i.id)).toEqual(["no_purchases"]);
    // Purchases not read yet: nothing to say.
    expect(advertisingInsights({ platforms: [{ ...meta, purchases: null, roas: null }], totals: { spend: 100, purchases: null, purchaseValue: null, roas: null }, margin: null }, f)).toEqual([]);
  });

  it("keeps to the limit, most telling first", () => {
    const many: AdInsightInput = { ...both, platforms: [{ ...meta, roas: 0.8 }, google], margin: 0.5 };
    expect(advertisingInsights(many, f, 10).length).toBe(5);
    expect(advertisingInsights(many, f).length).toBe(4);
    expect(advertisingInsights(many, f, 2).map((i) => i.id)).toEqual(["below_one", "best_roas"]);
  });
});

describe("key insights with Meta and Google both counted", () => {
  it("never states a ROAS of their claims added up: each platform's own, named, beside where the money went", () => {
    const got = advertisingInsights(both, f, 10);
    expect(got.map((i) => [i.id, i.provider])).toEqual([
      ["best_roas", undefined],
      ["share", undefined],
      ["roas_meaning", undefined],
    ]);
    expect(got[0]!.text).toBe("Meta Ads returns the most per $1 spent: 4.32×, against 3.45× for Google Ads, each by its own count.");
    // Spend adds up across platforms: its share is of the spend together.
    expect(got[1]!.text).toBe("Meta Ads took 59.3% of your ad spend.");
    // The totals' 3.97× (both claims added up) is nowhere.
    expect(got[2]!.text).toBe(
      "Meta Ads' ROAS of 4.32× means it credits $4.32 of purchases to every $1 spent, Google Ads' 3.45× that it credits $3.45, each by its own count: before product costs, fees and your other costs, so it isn't profit.",
    );
    expect(got.some((i) => i.text.includes("3.97"))).toBe(false);
  });

  it("works out that the claims don't add up from the platforms when the module doesn't say", () => {
    expect(advertisingInsights({ ...both, claimsAddUp: undefined }, f, 10).map((i) => i.text)).toEqual(advertisingInsights(both, f, 10).map((i) => i.text));
  });

  it("sets the break-even ROAS against each platform's own, naming the one that falls short", () => {
    const pays = advertisingInsights({ ...both, margin: 0.5 }, f, 10).find((i) => i.id === "break_even")!;
    expect(pays.tone).toBe("good");
    expect(pays.text).toBe("At your products' 50.0% margin, ads pay for what they sell above a ROAS of 2.00×: Meta Ads reports 4.32× and Google Ads 3.45×, each by its own count.");
    const short = advertisingInsights({ ...both, margin: 0.25 }, f, 10).find((i) => i.id === "break_even")!;
    expect(short.tone).toBe("warn");
    expect(short.text).toBe(
      "At your products' 25.0% margin, ads pay for what they sell above a ROAS of 4.00×: Meta Ads reports 4.32× and Google Ads 3.45×, each by its own count, so the sales Google Ads credits to its ads don't yet cover their product costs and its spend.",
    );
    const neither = advertisingInsights({ ...both, margin: 0.2 }, f, 10).find((i) => i.id === "break_even")!;
    expect(neither.text).toContain("so the sales Meta Ads and Google Ads credit to their ads don't yet cover their product costs and the spend.");
    // A platform with no purchase credited has no ROAS to set against it; the demo, nothing.
    const once = advertisingInsights({ ...both, margin: 0.5, platforms: [both.platforms[0]!, { ...google, purchases: 0, purchaseValue: 0, roas: 0 }] }, f, 10).find((i) => i.id === "break_even")!;
    expect(once.text).toBe("At your products' 50.0% margin, ads pay for what they sell above a ROAS of 2.00×: Meta Ads reports 4.32×, by its own count.");
    expect(advertisingInsights({ ...both, margin: 0.5, demo: true }, f, 10).some((i) => i.id === "break_even")).toBe(false);
  });
});
