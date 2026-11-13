/**
 * The dashboard's dates as Sales by collection asks for them (GET …/analytics/collections/sales):
 * the days the dashboard's answer is for, so the panel never shows other days than the figures
 * above it. (While the panel's answer also held the period before, it asked by the preset's name,
 * so that period was worked out as the dashboard's own.)
 */
export function collectionSalesParams(ov: { range: { from: string; to: string } }): URLSearchParams {
  return new URLSearchParams({ preset: "custom", from: ov.range.from, to: ov.range.to });
}
