/**
 * Business events (the Profit sheet, /sheet; docs/kpis.md "Profit sheet"): what happened in the
 * business on some days, as the team marks it: a sale, an ad campaign, a product launch, an email
 * sent, a holiday, a stock problem, a change to the website. The sheet shows each one on its days
 * and filters the days by them, so the figures of those days can be read against the rest.
 *
 * They are notes only: no figure is worked out from them, and nothing is read from Shopify or an ad
 * platform to make them. Days are store-local calendar days (YYYY-MM-DD), both ends included.
 */
// Extensionless imports: the web app imports this file directly (@app/shared/businessEvents).
import { daysBetweenInclusive, isDay, type DateRange } from "./dates";
import { z } from "./zod";

/** What an event is, in the order the sheet offers them. */
export const BUSINESS_EVENT_KINDS = ["sale", "campaign", "launch", "email", "holiday", "stock", "website", "other"] as const;
export type BusinessEventKind = (typeof BUSINESS_EVENT_KINDS)[number];

export const BUSINESS_EVENT_KIND_LABEL: Record<BusinessEventKind, string> = {
  sale: "Sale or discount",
  campaign: "Ad campaign",
  launch: "Product launch",
  email: "Email or SMS sent",
  holiday: "Holiday or season",
  stock: "Stock problem",
  website: "Website change",
  other: "Other",
};

export const isBusinessEventKind = (s: string): s is BusinessEventKind => (BUSINESS_EVENT_KINDS as readonly string[]).includes(s);

/** The most events one store keeps: years of a busy calendar, few enough to send with every sheet. */
export const MAX_BUSINESS_EVENTS = 1000;
/** The longest one event runs: a year (a season, a year-long promotion). */
export const MAX_BUSINESS_EVENT_DAYS = 366;

const day = z.string().refine((s) => isDay(s), "Pick a real date (YYYY-MM-DD)");

/** What POST …/business-events and PUT …/business-events/:id take: one event, whole. */
export const businessEventInput = z
  .object({
    title: z.string().trim().min(1, "Give the event a name").max(80),
    kind: z.enum(BUSINESS_EVENT_KINDS),
    /** Its first day; `endsOn` its last (the same day for a one-day event). */
    startsOn: day,
    endsOn: day,
    note: z.string().trim().max(500).nullable(),
  })
  .strict()
  .refine((x) => x.endsOn >= x.startsOn, { message: "It can't end before it starts", path: ["endsOn"] })
  .refine((x) => x.endsOn < x.startsOn || daysBetweenInclusive(x.startsOn, x.endsOn) <= MAX_BUSINESS_EVENT_DAYS, {
    message: `An event runs ${MAX_BUSINESS_EVENT_DAYS} days at most`,
    path: ["endsOn"],
  });

export type BusinessEventInput = z.infer<typeof businessEventInput>;

/** One event as the API returns it. */
export interface BusinessEvent extends BusinessEventInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** The part of an event the sheet's maths work with. */
export type EventSpan = Pick<BusinessEvent, "startsOn" | "endsOn">;

/** Whether the event runs on `day`. */
export const eventCovers = (e: EventSpan, day: string): boolean => e.startsOn <= day && day <= e.endsOn;

/** Whether the event runs on any day of `range`. */
export const eventOverlaps = (e: EventSpan, range: DateRange): boolean => e.startsOn <= range.to && e.endsOn >= range.from;

/** The events running on `day`, earliest first (then by name), as the sheet lists them under a day. */
export function eventsOn<E extends EventSpan & { title: string }>(events: readonly E[], day: string): E[] {
  return events.filter((e) => eventCovers(e, day)).sort(byStart);
}

/** Earliest first, then the longest, then by name: the order events are listed in everywhere. */
export function byStart(a: EventSpan & { title: string }, b: EventSpan & { title: string }): number {
  return a.startsOn.localeCompare(b.startsOn) || b.endsOn.localeCompare(a.endsOn) || a.title.localeCompare(b.title);
}
