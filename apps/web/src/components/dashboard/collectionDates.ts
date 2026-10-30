import { addDays, daysBetweenInclusive, type CompareMode } from "@app/shared/dates";

/**
 * The dashboard's dates as Sales by collection asks for them (GET …/analytics/collections/sales).
 * The panel has the dates the dashboard worked out, not the preset it worked them out from, so the
 * range goes as custom dates. The comparison goes as its mode whenever the route, working from
 * custom dates, gets the same days: always for the same dates a year earlier, and for the period
 * just before when it is next to the range and as long. Only otherwise as dates of its own (this
 * week against the same days last week, a month against the whole month before, dates picked),
 * which the dashboard has already let through as such.
 *
 * Never the period just before a 366-day range as dates: without a 29 February it runs a day past
 * the 12 months custom comparison dates may span, and the route would refuse it.
 */
export function collectionSalesParams(range: { from: string; to: string }, previous: { from: string; to: string; compare?: CompareMode }): URLSearchParams {
  const dates = { preset: "custom", from: range.from, to: range.to };
  if (previous.compare === "year") return new URLSearchParams({ ...dates, compare: "year" });
  const justBefore = previous.to === addDays(range.from, -1) && daysBetweenInclusive(previous.from, previous.to) === daysBetweenInclusive(range.from, range.to);
  if (justBefore) return new URLSearchParams({ ...dates, compare: "previous" });
  return new URLSearchParams({ ...dates, compare: "custom", cfrom: previous.from, cto: previous.to });
}
