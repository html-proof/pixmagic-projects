import { describe, expect, it } from "vitest";
import { advertisingInsights, type AdInsightInput } from "../src/adInsights";

const f = { money: (n: number) => `$${n.toFixed(2)}`, unit: "$1", pct: (n: number) => `${(n * 100).toFixed(1)}%`, times: (n: number) => `${n.toFixed(2)}×` };

const meta = { provider: "meta" as const, spend: 7620, purchases: 3120, purchaseValue: 32918.4, roas: 4.32 };
const google = { provider: "google" as const, spend: 5230, purchases: 1120, purchaseValue: 18043.5, roas: 3.45 };
/** One platform counted: the module's totals are its own figures. */
const one: AdInsightInput = {
  platforms: [meta],
  totals: { spend: 7620, purchases: 3120, purchaseValue: 32918.4, roas: 4.32 },
  deltas: { spend: 0.125, purchases: 0.224, purchaseValue: 0.287 },
  versus: "vs 1 – 30 Sep",
  margin: null,
};
/** Meta and Google both counted: the totals' purchases add up two claims that can overlap. */
const both: AdInsightInput = {
  platforms: [
    { ...meta, deltas: { spend: 0.1, purchases: 0.2, purchaseValue: 0.287 }, versus: "vs 1 – 30 Sep" },
    { ...google, deltas: { spend: 0.02, purchases: 0.01, purchaseValue: 0.01 }, versus: "vs 1 – 30 Sep" },
  ],
  totals: { spend: 12850, purchases: 4240, purchaseValue: 50961.9, roas: 3.97 },
  deltas: { spend: 0.125, purchases: 0.224, purchaseValue: 0.287 },
  versus: "vs 1 – 30 Sep",
  margin: null,
  claimsAddUp: false,
};

describe("the Advertising overview's key insights", () => {
  it("with one platform, says what changed and what its ROAS means, as the platform's own count", () => {
    const got = advertisingInsights(one, f, 10);
    expect(got.map((i) => i.id)).toEqual(["value_change", "roas_meaning"]);
    expect(got[0]!.text).toBe("The purchase value your platforms credit to their ads is up 28.7% vs 1 – 30 Sep.");
    expect(got[1]!.text).toBe("A ROAS of 4.32× means the platforms credit $4.32 of purchases to every $1 spent: before product costs, fees and your other costs, so it isn't profit.");
  });

  it("warns when spend rises while purchases fall, and when a platform credits less than it cost", () => {
    const got = advertisingInsights({ ...one, platforms: [{ ...google, roas: 0.8 }], deltas: { spend: 0.2, purchases: -0.1, purchaseValue: -0.05 } }, f, 10);
    expect(got.map((i) => [i.id, i.tone])).toEqual([
      ["below_one", "bad"],
      ["spend_outpaces", "warn"],
      ["roas_meaning", "info"],
    ]);
    expect(got[1]!.text).toBe("Ad spend is up 20.0% vs 1 – 30 Sep while the platforms counted 10.0% fewer purchases.");
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
    const none = advertisingInsights({ platforms: [{ ...meta, purchases: 0, purchaseValue: 0, roas: 0 }], totals: { spend: 100, purchases: 0, purchaseValue: 0, roas: 0 }, deltas: null, versus: null, margin: 0.4 }, f, 10);
    expect(none.map((i) => i.id)).toEqual(["no_purchases"]);
    // Purchases not read yet, nothing compared: nothing to say.
    expect(advertisingInsights({ platforms: [{ ...meta, purchases: null, roas: null }], totals: { spend: 100, purchases: null, purchaseValue: null, roas: null }, deltas: null, versus: null, margin: null }, f)).toEqual([]);
    // A small change isn't news.
    expect(advertisingInsights({ ...one, deltas: { spend: 0.01, purchases: 0.01, purchaseValue: 0.02 } }, f, 10).some((i) => i.id === "value_change")).toBe(false);
  });

  it("keeps to the limit, most telling first", () => {
    expect(advertisingInsights(both, f).length).toBe(4);
    expect(advertisingInsights(both, f, 2).map((i) => i.id)).toEqual(["value_change", "best_roas"]);
  });
});

describe("key insights with Meta and Google both counted", () => {
  it("never states a ROAS or a change of their claims added up: each platform's own, named, beside where the money went", () => {
    const got = advertisingInsights(both, f, 10);
    expect(got.map((i) => [i.id, i.provider])).toEqual([
      ["value_change", "meta"],
      ["best_roas", undefined],
      ["share", undefined],
      ["roas_meaning", undefined],
    ]);
    // Meta's own purchase value is up 28.7%; Google's 1% isn't news. The module's summed 28.7% isn't used.
    expect(got[0]!.text).toBe("The purchase value Meta Ads credits to its ads is up 28.7% vs 1 – 30 Sep.");
    expect(got[1]!.text).toBe("Meta Ads returns the most per $1 spent: 4.32×, against 3.45× for Google Ads, each by its own count.");
    // Spend adds up across platforms: its share is of the spend together.
    expect(got[2]!.text).toBe("Meta Ads took 59.3% of your ad spend.");
    // The totals' 3.97× (both claims added up) is nowhere.
    expect(got[3]!.text).toBe(
      "Meta Ads' ROAS of 4.32× means it credits $4.32 of purchases to every $1 spent, Google Ads' 3.45× that it credits $3.45, each by its own count: before product costs, fees and your other costs, so it isn't profit.",
    );
    expect(got.some((i) => i.text.includes("3.97"))).toBe(false);
  });

  it("works out that the claims don't add up from the platforms when the module doesn't say", () => {
    expect(advertisingInsights({ ...both, claimsAddUp: undefined }, f, 10).map((i) => i.text)).toEqual(advertisingInsights(both, f, 10).map((i) => i.text));
  });

  it("warns of each platform whose own spend rose while its own purchases fell", () => {
    const got = advertisingInsights(
      { ...both, platforms: [{ ...both.platforms[0]!, deltas: { spend: 0.3, purchases: -0.1, purchaseValue: -0.1 } }, { ...both.platforms[1]!, deltas: { spend: 0.2, purchases: -0.25, purchaseValue: -0.2 } }] },
      f,
      10,
    ).filter((i) => i.id === "spend_outpaces");
    expect(got.map((i) => i.text)).toEqual([
      "Meta Ads spend is up 30.0% vs 1 – 30 Sep while it counted 10.0% fewer purchases.",
      "Google Ads spend is up 20.0% vs 1 – 30 Sep while it counted 25.0% fewer purchases.",
    ]);
    // A platform not compared says nothing of a change.
    expect(advertisingInsights({ ...both, platforms: both.platforms.map((p) => ({ ...p, deltas: null, versus: null })) }, f, 10).some((i) => i.id === "value_change" || i.id === "spend_outpaces")).toBe(false);
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
