import { describe, expect, it } from "vitest";
import {
  aggregateDaily,
  BUILT_IN_PRESETS,
  builtInPreset,
  calculationName,
  chargeLine,
  CUSTOM_NAME,
  customApplied,
  customSales,
  DEFAULT_CALCULATION,
  differenceFromShopify,
  isStandard,
  localDay,
  readCalculation,
  salesCalculationInput,
  SALES_COMPONENTS,
  SHOPIFY_STANDARD,
  splitTotal,
  summarize,
  type ComponentSelection,
  type SaleInput,
  type SalesLines,
} from "../src/index.js";

// The example in the brief (amounts in rupees): Shopify's total sales is ₹1,00,000.
const lines: SalesLines = { netSales: 85000, additionalFees: 1500, duties: 500, shipping: 4000, taxes: 9000, totalSales: 100000 };
const only = (...keys: Array<keyof ComponentSelection>): ComponentSelection => Object.fromEntries(SALES_COMPONENTS.map((k) => [k, keys.includes(k)])) as ComponentSelection;
const without = (...keys: Array<keyof ComponentSelection>): ComponentSelection => ({ ...SHOPIFY_STANDARD, ...Object.fromEntries(keys.map((k) => [k, false])) });

describe("Custom sales from the lines of Shopify's total sales", () => {
  it("is Shopify's total sales by default: every line", () => {
    expect(isStandard(DEFAULT_CALCULATION.components)).toBe(true);
    expect(customSales(lines, SHOPIFY_STANDARD)).toBe(lines.totalSales);
    expect(differenceFromShopify(lines, SHOPIFY_STANDARD)).toBe(0);
    expect(splitTotal(lines).unsplit).toBe(0);
  });

  it("leaves out each line on its own", () => {
    expect(customSales(lines, without("taxes"))).toBe(91000);
    expect(customSales(lines, without("shipping"))).toBe(96000);
    expect(customSales(lines, without("duties"))).toBe(99500);
    expect(customSales(lines, without("additionalFees"))).toBe(98500);
    expect(customSales(lines, without("netSales"))).toBe(15000);
  });

  it("leaves out several at once: taxes and duties off gives ₹90,500", () => {
    expect(customSales(lines, without("taxes", "duties"))).toBe(90500);
    expect(differenceFromShopify(lines, without("taxes", "duties"))).toBe(9500);
    expect(customSales(lines, only("netSales"))).toBe(85000);
  });

  it("never changes Shopify's total sales, whatever is switched off", () => {
    const before = { ...lines };
    customSales(lines, only("netSales"));
    differenceFromShopify(lines, without("taxes", "shipping"));
    expect(lines).toEqual(before);
  });

  it("adds up in whole cents, so floating-point sums don't creep in", () => {
    const x = { netSales: 0.1, additionalFees: 0.2, duties: 0, shipping: 0, taxes: 0.03, totalSales: 0.33 };
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(customSales(x, without("taxes"))).toBe(0.3);
    expect(customSales(x, SHOPIFY_STANDARD)).toBe(0.33);
    expect(differenceFromShopify(x, without("taxes"))).toBe(0.03);
    // A thousand one-cent days, as a long range sums them.
    const days = Array.from({ length: 1000 }, () => ({ netSales: 0.01, additionalFees: 0, duties: 0, shipping: 0, taxes: 0 }));
    expect(days.reduce((a, d) => Math.round((a + customSales(d, SHOPIFY_STANDARD)) * 100) / 100, 0)).toBe(10);
  });

  it("keeps the signs Shopify gave: a refund-heavy day can make a line negative", () => {
    const refunds = { netSales: -120.5, additionalFees: 0, duties: -4, shipping: -10, taxes: -13.45, totalSales: -147.95 };
    expect(customSales(refunds, SHOPIFY_STANDARD)).toBe(-147.95);
    expect(customSales(refunds, without("taxes", "duties"))).toBe(-130.5);
  });

  it("reports what total sales holds and no line does, never folding it into one", () => {
    // A day stored before the lines were kept: its total holds A$12.00 of duties that no line shows.
    const old = { netSales: 100, additionalFees: 0, duties: 0, shipping: 10, taxes: 11, totalSales: 133 };
    expect(splitTotal(old)).toEqual({ lines: { netSales: 100, additionalFees: 0, duties: 0, shipping: 10, taxes: 11 }, unsplit: 12 });
    expect(customSales(old, SHOPIFY_STANDARD)).toBe(121);
    expect(differenceFromShopify(old, SHOPIFY_STANDARD)).toBe(12);
  });
});

describe("calculations ready made, and the merchant's own", () => {
  it("names the built-in calculations by their lines", () => {
    expect(BUILT_IN_PRESETS.map((p) => p.id)).toEqual(["shopify", "product_revenue", "excl_tax", "excl_shipping", "excl_tax_duties"]);
    expect(builtInPreset(SHOPIFY_STANDARD)?.label).toBe("Shopify standard");
    expect(builtInPreset(only("netSales"))?.label).toBe("Product revenue only");
    expect(builtInPreset(without("taxes"))?.label).toBe("Sales excluding tax");
    expect(builtInPreset(without("shipping"))?.label).toBe("Sales excluding shipping");
    expect(builtInPreset(without("taxes", "duties"))?.label).toBe("Sales excluding tax and duties");
    expect(builtInPreset(without("additionalFees"))).toBeNull();
  });

  it("each built-in calculation counts only real lines of the store", () => {
    for (const p of BUILT_IN_PRESETS) expect(Object.keys(p.components).sort()).toEqual([...SALES_COMPONENTS].sort());
    expect(customSales(lines, BUILT_IN_PRESETS.find((p) => p.id === "excl_tax")!.components)).toBe(91000);
  });

  it("calls a calculation by its built-in name, else the merchant's, else the default", () => {
    expect(calculationName({ components: without("taxes"), label: "ignored" })).toBe("Sales excluding tax");
    expect(calculationName({ components: without("additionalFees"), label: "Wholesale revenue" })).toBe("Wholesale revenue");
    expect(calculationName({ components: without("additionalFees"), label: null })).toBe(CUSTOM_NAME);
  });

  it("shows Custom sales across the dashboard only when applied and different from Shopify's figure", () => {
    expect(customApplied(null)).toBe(false);
    expect(customApplied({ components: without("taxes"), applyToDashboard: false })).toBe(false);
    expect(customApplied({ components: SHOPIFY_STANDARD, applyToDashboard: true })).toBe(false);
    expect(customApplied({ components: without("taxes"), applyToDashboard: true })).toBe(true);
  });
});

describe("the saved calculation", () => {
  const valid = { components: without("taxes"), label: null, applyToDashboard: true, presets: [{ name: "Retail", components: without("duties") }] };

  it("takes a whole, valid setting", () => {
    expect(salesCalculationInput.parse(valid)).toEqual(valid);
  });

  it("refuses a calculation of nothing, unknown lines, amounts and duplicate names", () => {
    expect(salesCalculationInput.safeParse({ ...valid, components: only() }).success).toBe(false);
    expect(salesCalculationInput.safeParse({ ...valid, components: { ...SHOPIFY_STANDARD, tips: true } }).success).toBe(false);
    // Only the choice is kept: a figure can't be stored with it.
    expect(salesCalculationInput.safeParse({ ...valid, totalSales: 100000 }).success).toBe(false);
    expect(salesCalculationInput.safeParse({ ...valid, presets: [valid.presets[0], { name: "retail", components: SHOPIFY_STANDARD }] }).success).toBe(false);
    expect(salesCalculationInput.safeParse({ ...valid, presets: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, components: SHOPIFY_STANDARD })) }).success).toBe(false);
    expect(salesCalculationInput.safeParse({ ...valid, label: "x".repeat(61) }).success).toBe(false);
  });

  it("reads a stored row defensively: anything unreadable is Shopify standard, never an error", () => {
    const at = new Date("2026-10-19T00:00:00Z");
    expect(readCalculation(null)).toEqual(DEFAULT_CALCULATION);
    expect(readCalculation({ components: { netSales: "yes" }, label: null, applyToDashboard: true, presets: "nope", updatedAt: at })).toEqual({
      components: SHOPIFY_STANDARD,
      label: null,
      applyToDashboard: true,
      presets: [],
      updatedAt: at.toISOString(),
    });
    expect(readCalculation({ components: without("taxes"), label: "Mine", applyToDashboard: false, presets: [], updatedAt: at }).components).toEqual(without("taxes"));
  });
});

describe("duties and additional fees in the reference aggregation", () => {
  const sale = (lineType: string, amount: number, tax: number, actionType = "order"): SaleInput => ({ orderId: "o1", happenedAt: new Date("2026-10-18T03:00:00Z"), actionType, lineType, quantity: null, amount, discount: 0, tax });
  const order = { id: "o1", createdAt: new Date("2026-10-18T03:00:00Z"), customerKey: null, isReturningCustomer: false };

  it("files each charge on its own line, its tax among taxes, and the lines add up to total sales", () => {
    expect(["duty", "fee", "additional_fee", "unknown"].map(chargeLine)).toEqual(["duties", "additionalFees", "additionalFees", "additionalFees"]);
    const rows = aggregateDaily(
      [order],
      [
        { ...sale("product", 110, 10), quantity: 1 },
        sale("shipping", 11, 1),
        sale("duty", 44, 4),
        sale("additional_fee", 2.2, 0.2),
        sale("fee", 1.1, 0.1),
        // Gift cards and tips are in no line, as in Shopify's reports.
        sale("gift_card", 50, 0),
        sale("tip", 5, 0),
        // A refund of the duty, later the same day.
        sale("duty", -22, -2, "return"),
      ],
      "UTC",
      localDay,
    );
    const t = summarize([...rows.values()]);
    expect(t).toMatchObject({ netSales: 100, shipping: 10, duties: 20, additionalFees: 3, taxes: 13.3, totalSales: 146.3 });
    const x = { netSales: t.netSales, additionalFees: t.additionalFees, duties: t.duties, shipping: t.shipping, taxes: t.taxes, totalSales: t.totalSales };
    expect(splitTotal(x).unsplit).toBe(0);
    expect(customSales(x, SHOPIFY_STANDARD)).toBe(t.totalSales);
  });

  it("counts the store's money only: each sale's amount is in shop money, whatever currency the customer paid in", () => {
    // The normalizer reads shopMoney (packages/core/src/normalize.ts); a presentment amount never reaches a sale.
    const rows = aggregateDaily([order], [{ ...sale("product", 55, 5), quantity: 1 }], "Asia/Kolkata", localDay);
    expect(summarize([...rows.values()]).totalSales).toBe(55);
  });
});
