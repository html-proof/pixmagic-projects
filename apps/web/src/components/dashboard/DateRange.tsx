"use client";
import { useEffect, useState } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";
import { customRangeProblem, daysBetweenInclusive, isDay, localDay, MIN_CUSTOM_DAY, type Comparison, type CustomRangeProblem, type DateRange } from "@app/shared/dates";
import { fmtClock, fmtDay, fmtRange, fmtSpan } from "./format";

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "mtd", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "custom", label: "Custom" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

const CUSTOM_HINT: Record<CustomRangeProblem, string> = {
  incomplete: "Pick a start and an end date.",
  reversed: "The start date is after the end date.",
  future: "The start date hasn't happened yet in the store's time zone.",
  too_long: "Pick up to a year at a time.",
};

/** What a question looks like in the address bar and in the API call: `preset=7d`, `preset=custom&from=…&to=…`. */
type Question = { qs: string; label: string };
const DEFAULT: Question = { qs: "preset=30d", label: "Last 30 days" };
const PARAMS = ["preset", "from", "to"] as const;

/** The last dates looked at in this tab, for coming back to the dashboard from another page. */
const LAST_RANGE_KEY = "insights:dashboard-range";

type Choice = { preset: PresetId; from: string; to: string };

function parseChoice(search: string | null): Choice | null {
  if (!search) return null;
  const q = new URLSearchParams(search);
  const preset = PRESETS.find((p) => p.id === q.get("preset"))?.id;
  if (!preset) return null;
  if (preset !== "custom") return { preset, from: "", to: "" };
  const from = q.get("from");
  const to = q.get("to");
  return isDay(from) && isDay(to) ? { preset, from, to } : null;
}

function storeToday(timeZone: string): string {
  try {
    return localDay(new Date(), timeZone);
  } catch {
    // A zone this browser doesn't know: the API answers for the right one, this only bounds the pickers.
    return localDay(new Date(), "UTC");
  }
}

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_RANGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The dates the dashboard reports on.
 *
 * `asking` is the question to send. A custom range only takes over once it is finished and valid:
 * asking for each half-typed one (a year arrives as 0002, 0020, 0202…) flashed an error per digit.
 * Until then the last good question stays live instead of the page stalling on "Checking".
 *
 * The choice is kept in the address bar and for the rest of the tab's session, so a reload, the
 * back button, a shared link or a trip to Settings and back no longer drops it to the last 30 days.
 * `asking` stays null until that has been read, so the page doesn't first load the default dates.
 */
export function useDateRange(timeZone: string) {
  const [choice, setChoice] = useState<Choice>({ preset: "30d", from: "", to: "" });
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState<Question>(DEFAULT);
  // The store's today: custom dates can't start after it, and are reported up to it at most.
  const today = storeToday(timeZone);
  const problem = choice.preset === "custom" ? customRangeProblem(choice, today) : null;

  if (restored && !problem) {
    const qs = choice.preset === "custom" ? `preset=custom&from=${choice.from}&to=${choice.to}` : `preset=${choice.preset}`;
    const label = choice.preset === "custom" ? fmtRange(choice.from, choice.to) : PRESETS.find((p) => p.id === choice.preset)!.label;
    if (qs !== asking.qs) setAsking({ qs, label });
  }

  useEffect(() => {
    const saved = parseChoice(window.location.search) ?? parseChoice(readStored());
    if (saved) setChoice(saved);
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      window.sessionStorage.setItem(LAST_RANGE_KEY, asking.qs);
    } catch {
      // Private mode or blocked storage: the address bar still has it.
    }
    const url = new URL(window.location.href);
    for (const k of PARAMS) url.searchParams.delete(k);
    if (asking.qs !== DEFAULT.qs) new URLSearchParams(asking.qs).forEach((v, k) => url.searchParams.set(k, v));
    // Replace rather than push: each click on a date button isn't a page to go back through.
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url.href);
  }, [asking.qs, restored]);

  /**
   * Custom starts from the dates on screen, so choosing it shows numbers straight away and only
   * the end being changed has to be picked, instead of two empty boxes beside other dates' numbers.
   */
  const choose = (preset: PresetId, shown?: DateRange) =>
    setChoice((c) => (preset === "custom" && !c.from && !c.to && shown ? { preset, ...shown } : { ...c, preset }));

  return {
    ...choice,
    today,
    problem,
    asking: restored ? asking : null,
    choose,
    setFrom: (from: string) => setChoice((c) => ({ ...c, from })),
    setTo: (to: string) => setChoice((c) => ({ ...c, to })),
  };
}

export type DateRangeState = ReturnType<typeof useDateRange>;

/** What the numbers on the page are for, once they have loaded. */
export type Shown = { range: DateRange; previous: Comparison; timezone: string } | null;

/**
 * "Compared with 18 Aug – 16 Sep" for a tooltip, once the numbers have loaded; "Compared with
 * 16 Oct until 4:44 pm, the same time of day" while the dates picked are still running.
 */
export const comparedWith = (shown: Shown) =>
  shown
    ? `Compared with ${fmtSpan(shown.previous.from, shown.previous.to)}${shown.previous.until ? ` until ${fmtClock(shown.previous.until)}, the same time of day` : ""}`
    : undefined;

/**
 * What a change is on, short enough for under a headline number: "vs same time yesterday",
 * "vs previous 30 days". Last month is compared with the whole month before it, whatever its length.
 */
export function versusWords(shown: Shown): string {
  if (!shown) return "vs previous period";
  const days = daysBetweenInclusive(shown.range.from, shown.range.to);
  if (days === 1) return shown.previous.until ? "vs same time yesterday" : "vs the day before";
  if (daysBetweenInclusive(shown.previous.from, shown.previous.to) !== days) return "vs the month before";
  return `vs previous ${days} days`;
}

/**
 * The dates menu: a pill naming the dates, with the native select laid over it, so it opens the
 * system's own list and keyboards and screen readers get a real select. `label` names it for them;
 * the page has one "Dates" menu, and the summary card repeats it as "Period".
 */
export function DateRangeSelect({
  r,
  shown,
  id,
  label,
  size = "md",
}: {
  r: DateRangeState;
  shown: Shown;
  id: string;
  label: string;
  size?: "sm" | "md";
}) {
  const text =
    r.preset !== "custom" ? PRESETS.find((p) => p.id === r.preset)!.label : r.from && r.to && !r.problem ? fmtRange(r.from, r.to) : "Pick dates";
  return (
    <div
      className={`relative inline-flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface font-medium shadow-[var(--shadow)] transition-colors focus-within:ring-2 focus-within:ring-accent hover:border-accent/40 ${
        size === "sm" ? "h-9 pl-3 pr-8 text-xs" : "h-10 pl-3.5 pr-10 text-sm"
      }`}
      title={shown ? `${fmtSpan(shown.range.from, shown.range.to)}. ${comparedWith(shown)}. Days follow the store's time zone (${shown.timezone}).` : undefined}
    >
      {size === "md" && <CalendarDays aria-hidden className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.8} />}
      <span aria-hidden className="truncate">{text}</span>
      <ChevronDown aria-hidden className={`pointer-events-none absolute h-4 w-4 text-muted ${size === "sm" ? "right-2.5" : "right-3.5"}`} />
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        value={r.preset}
        onChange={(e) => r.choose(e.target.value as PresetId, shown?.range)}
      >
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.id === "custom" ? "Pick dates…" : p.label}</option>
        ))}
      </select>
    </div>
  );
}

/** With "Pick dates…" chosen: the two date boxes, and what is wrong with them while they don't make a range yet. */
export function CustomDates({ r }: { r: DateRangeState }) {
  if (r.preset !== "custom") return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <input aria-label="From" type="date" min={MIN_CUSTOM_DAY} max={r.today} className="input w-auto py-1.5" value={r.from} onChange={(e) => r.setFrom(e.target.value)} />
        to
        <input aria-label="To" type="date" min={MIN_CUSTOM_DAY} max={r.today} className="input w-auto py-1.5" value={r.to} onChange={(e) => r.setTo(e.target.value)} />
      </span>
      {r.problem && (
        <p className={`text-xs ${r.problem === "incomplete" ? "text-muted" : "text-warn"}`} role="status">{CUSTOM_HINT[r.problem]}</p>
      )}
    </div>
  );
}

/** "in the last 30 days", "today", "between 1 Mar and 8 Mar 2026": the dates, for the end of a sentence. */
export function periodWords(r: DateRangeState, shown: Shown): string {
  switch (r.preset) {
    case "today":
      return "today";
    case "yesterday":
      return "yesterday";
    case "mtd":
      return "this month";
    case "lastmonth":
      return "last month";
    case "custom":
      return shown ? (shown.range.from === shown.range.to ? `on ${fmtDay(shown.range.from)}` : `from ${fmtSpan(shown.range.from, shown.range.to)}`) : "in the dates you picked";
    default:
      return `in the ${PRESETS.find((p) => p.id === r.preset)!.label.toLowerCase()}`;
  }
}
