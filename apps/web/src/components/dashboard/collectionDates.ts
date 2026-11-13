import type { DatePreset } from "@app/shared/dates";

/**
 * The dashboard's dates as Sales by collection asks for them (GET …/analytics/collections/sales):
 * as the dashboard itself was asked (`preset`, in its answer), so the route works out the same days
 * on both sides. "This week" is compared with the same days of the week before and "Last month"
 * with the whole month before, which the same days written out as custom dates are not.
 *
 * Custom dates, and an answer that doesn't say how it was asked, go as the dates themselves.
 */
export function collectionSalesParams(ov: { preset?: DatePreset; range: { from: string; to: string } }): URLSearchParams {
  if (ov.preset && ov.preset !== "custom") return new URLSearchParams({ preset: ov.preset });
  return new URLSearchParams({ preset: "custom", from: ov.range.from, to: ov.range.to });
}
