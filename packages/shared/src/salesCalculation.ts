/**
 * Shopify's total sales, line by line, and a merchant's own calculation from those lines
 * ("Custom sales"). docs/kpis.md, "Total sales breakdown and Custom sales".
 *
 * Shopify's identity: total sales = net sales + additional fees + duties + shipping charges +
 * taxes (ShopifyQL `FROM sales SHOW ...` gives each line, and they add up to the cent). Every line
 * here is that store's own figure for the dates, added up from Shopify's sales records; nothing is
 * estimated. A merchant may leave lines out of Custom sales (sales without tax, product revenue
 * only...), but Shopify's total sales is never changed by it: the two are shown side by side.
 *
 * Money is added up in whole cents: every figure is a sum of 2-dp amounts, so the result is exact
 * and doesn't depend on the order of a floating-point sum.
 */
// Extensionless imports: the web app imports this file directly (@app/shared/salesCalculation).
import { z } from "./zod";

/** The lines of Shopify's total sales, in the order its breakdown lists them. */
export const SALES_COMPONENTS = ["netSales", "additionalFees", "duties", "shipping", "taxes"] as const;
export type SalesComponent = (typeof SALES_COMPONENTS)[number];

/** Which lines a calculation counts. */
export type ComponentSelection = Record<SalesComponent, boolean>;

export const COMPONENT_INFO: Record<SalesComponent, { label: string; help: string }> = {
  netSales: { label: "Net sales", help: "Gross sales less discounts and returns (sales reversals): what the items sold for, before tax and shipping." },
  additionalFees: { label: "Additional fees", help: "Fees Shopify adds to orders besides shipping and duties, such as a retail delivery fee, before tax." },
  duties: { label: "Duties", help: "Import duties collected from customers at checkout, before tax." },
  shipping: { label: "Shipping charges", help: "What customers paid for shipping, after shipping discounts and refunds, before tax." },
  taxes: { label: "Taxes", help: "Every tax on the sale: on items, shipping, duties and fees." },
};

/** Shopify's total sales: every line. */
export const SHOPIFY_STANDARD: ComponentSelection = { netSales: true, additionalFees: true, duties: true, shipping: true, taxes: true };

export type BuiltInPresetId = "shopify" | "product_revenue" | "excl_tax" | "excl_shipping" | "excl_tax_duties";

/** Calculations most businesses want, ready made. "Custom business revenue" is the merchant's own. */
export const BUILT_IN_PRESETS: ReadonlyArray<{ id: BuiltInPresetId; label: string; description: string; components: ComponentSelection }> = [
  { id: "shopify", label: "Shopify standard", description: "Shopify's total sales, every line.", components: SHOPIFY_STANDARD },
  { id: "product_revenue", label: "Product revenue only", description: "Net sales alone: what the items sold for.", components: { ...off(), netSales: true } },
  { id: "excl_tax", label: "Sales excluding tax", description: "Total sales without taxes, for prices that include tax or tax you pass on.", components: { ...SHOPIFY_STANDARD, taxes: false } },
  { id: "excl_shipping", label: "Sales excluding shipping", description: "Total sales without shipping charges.", components: { ...SHOPIFY_STANDARD, shipping: false } },
  { id: "excl_tax_duties", label: "Sales excluding tax and duties", description: "For international sales: what stays after taxes and duties are passed on.", components: { ...SHOPIFY_STANDARD, taxes: false, duties: false } },
];

/** What an unnamed calculation of the merchant's own is called. */
export const CUSTOM_NAME = "Custom business revenue";

function off(): ComponentSelection {
  return { netSales: false, additionalFees: false, duties: false, shipping: false, taxes: false };
}

/** One period's lines, and Shopify's total sales for it (the store's currency). */
export interface SalesLines {
  netSales: number;
  additionalFees: number;
  duties: number;
  shipping: number;
  taxes: number;
  totalSales: number;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * The lines with what they don't explain: `unsplit` is the part of total sales no line holds.
 * It is 0 for every day bizinsights added up from Shopify's sales records; only days stored before
 * those records were read (their total kept as it was) can carry one. Never folded into a line.
 */
export function splitTotal(x: SalesLines): { lines: Record<SalesComponent, number>; unsplit: number } {
  const lines = {} as Record<SalesComponent, number>;
  let sum = 0;
  for (const k of SALES_COMPONENTS) {
    lines[k] = cents(x[k]) / 100;
    sum += cents(x[k]);
  }
  return { lines, unsplit: (cents(x.totalSales) - sum) / 100 };
}

/** Custom sales: the lines the selection counts, added up in cents. */
export function customSales(x: Omit<SalesLines, "totalSales">, selection: ComponentSelection): number {
  let sum = 0;
  for (const k of SALES_COMPONENTS) if (selection[k]) sum += cents(x[k]);
  return sum / 100;
}

/**
 * Shopify's total sales less Custom sales: what the lines left out add up to, plus anything total
 * sales holds that no line does (`unsplit`).
 */
export function differenceFromShopify(x: SalesLines, selection: ComponentSelection): number {
  return (cents(x.totalSales) - cents(customSales(x, selection))) / 100;
}

export const isStandard = (s: ComponentSelection) => SALES_COMPONENTS.every((k) => s[k]);
export const sameSelection = (a: ComponentSelection, b: ComponentSelection) => SALES_COMPONENTS.every((k) => a[k] === b[k]);

/** The built-in calculation a selection is, if any. */
export const builtInPreset = (s: ComponentSelection) => BUILT_IN_PRESETS.find((p) => sameSelection(p.components, s)) ?? null;

// ---- The store's saved calculation (sales_calculations) ----

export const componentSelectionSchema = z
  .object({ netSales: z.boolean(), additionalFees: z.boolean(), duties: z.boolean(), shipping: z.boolean(), taxes: z.boolean() })
  .strict()
  .refine((s) => SALES_COMPONENTS.some((k) => s[k]), { message: "Choose at least one line to count." });

const nameSchema = z.string().trim().min(1).max(60);

export const MAX_SAVED_PRESETS = 10;

/** What PUT .../sales-calculation takes: the whole setting. */
export const salesCalculationInput = z
  .object({
    components: componentSelectionSchema,
    /** The name of a calculation of the merchant's own; ignored (null) for a built-in one. */
    label: nameSchema.nullable(),
    /** Show Custom sales next to Shopify's figures across the dashboard (the trend, the summary, downloads). */
    applyToDashboard: z.boolean(),
    /** Calculations the merchant keeps to switch between, by name. */
    presets: z.array(z.object({ name: nameSchema, components: componentSelectionSchema })).max(MAX_SAVED_PRESETS),
  })
  .strict()
  .refine((x) => new Set(x.presets.map((p) => p.name.toLowerCase())).size === x.presets.length, { message: "Two saved calculations have the same name.", path: ["presets"] });

export type SalesCalculationInput = z.infer<typeof salesCalculationInput>;

/** The store's calculation as the API returns it. */
export interface SalesCalculation extends SalesCalculationInput {
  /** When it was last saved; null while the store uses the default (Shopify standard, not applied). */
  updatedAt: string | null;
}

export const DEFAULT_CALCULATION: SalesCalculation = { components: SHOPIFY_STANDARD, label: null, applyToDashboard: false, presets: [], updatedAt: null };

/** A stored row read defensively: anything unreadable falls back to the default rather than failing the dashboard. */
export function readCalculation(row: { components: unknown; label: string | null; applyToDashboard: boolean; presets: unknown; updatedAt: Date } | null): SalesCalculation {
  if (!row) return DEFAULT_CALCULATION;
  const components = componentSelectionSchema.safeParse(row.components);
  const presets = z.array(z.object({ name: nameSchema, components: componentSelectionSchema })).safeParse(row.presets);
  return {
    components: components.success ? components.data : SHOPIFY_STANDARD,
    label: row.label,
    applyToDashboard: row.applyToDashboard,
    presets: presets.success ? presets.data.slice(0, MAX_SAVED_PRESETS) : [],
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What a calculation is called: a built-in one's name, else the merchant's own name for it. */
export function calculationName(c: Pick<SalesCalculation, "components" | "label">): string {
  return builtInPreset(c.components)?.label ?? c.label ?? CUSTOM_NAME;
}

/** Whether Custom sales is shown across the dashboard: applied, and different from Shopify's total sales. */
export const customApplied = (c: Pick<SalesCalculation, "components" | "applyToDashboard"> | null | undefined): boolean => !!c && c.applyToDashboard && !isStandard(c.components);
