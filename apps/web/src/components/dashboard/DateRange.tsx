"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, CalendarDays, ChevronDown, type LucideIcon } from "lucide-react";
import {
  customRangeProblem,
  daysBetweenInclusive,
  isDay,
  localDay,
  MIN_CUSTOM_DAY,
  storeRangeLimits,
  type CompareMode,
  type Comparison,
  type CustomRangeProblem,
  type DateRange,
} from "@app/shared/dates";
import { fmtClock, fmtComparison, fmtDay, fmtRange, fmtSpan } from "./format";

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "wtd", label: "This week" },
  { id: "mtd", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "ytd", label: "This year" },
  { id: "lastyear", label: "Last year" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

/** What the changes compare with, as Shopify Analytics' second date chip offers (`COMPARE_MODES` in @app/shared). */
export const COMPARISONS: ReadonlyArray<{ id: CompareMode; label: string }> = [
  { id: "previous", label: "Previous period" },
  { id: "year", label: "Previous year" },
  { id: "custom", label: "Custom" },
];

/** What is wrong with dates picked, in a line under them. `start` is the store's first day. */
function customHint(problem: CustomRangeProblem, start: string | null): string {
  switch (problem) {
    case "incomplete":
      return "Pick a start and an end date.";
    case "reversed":
      return "The start date is after the end date.";
    case "future":
      return "The start date hasn't happened yet in the store's time zone.";
    case "before_start":
      return `The store's data starts on ${fmtDay(start)}. Pick dates from then on.`;
    case "too_long":
      return "Pick up to a year at a time.";
  }
}

/**
 * What a question looks like in the address bar and in the API call: `preset=7d`,
 * `preset=custom&from=…&to=…`, then `&compare=year` or `&compare=custom&cfrom=…&cto=…` when the
 * changes aren't on the period just before.
 */
type Question = { qs: string; label: string };
const DEFAULT: Question = { qs: "preset=30d", label: "Last 30 days" };
const PARAMS = ["preset", "from", "to", "compare", "cfrom", "cto"] as const;

/** The last dates looked at in this tab, for coming back to the dashboard from another page. */
const LAST_RANGE_KEY = "insights:dashboard-range";

type Choice = { preset: PresetId; from: string; to: string; compare: CompareMode; cfrom: string; cto: string };

function parseChoice(search: string | null): Choice | null {
  if (!search) return null;
  const q = new URLSearchParams(search);
  const preset = PRESETS.find((p) => p.id === q.get("preset"))?.id;
  if (!preset) return null;
  const from = q.get("from");
  const to = q.get("to");
  if (preset === "custom" && !(isDay(from) && isDay(to))) return null;
  const dates = preset === "custom" ? { preset, from: from!, to: to! } : { preset, from: "", to: "" };
  // A comparison that can't be read falls back to the period before rather than dropping the dates.
  const compare = COMPARISONS.find((c) => c.id === q.get("compare"))?.id ?? "previous";
  const cfrom = q.get("cfrom");
  const cto = q.get("cto");
  if (compare === "custom") return isDay(cfrom) && isDay(cto) ? { ...dates, compare, cfrom, cto } : { ...dates, compare: "previous", cfrom: "", cto: "" };
  return { ...dates, compare, cfrom: "", cto: "" };
}

/** The question a finished, valid choice asks. */
function questionOf(c: Choice): Question {
  const dates = c.preset === "custom" ? `preset=custom&from=${c.from}&to=${c.to}` : `preset=${c.preset}`;
  const label = c.preset === "custom" ? fmtRange(c.from, c.to) : PRESETS.find((p) => p.id === c.preset)!.label;
  // All time has nothing before it to compare with (resolvePreset ignores the choice).
  if (c.preset === "all") return { qs: dates, label };
  if (c.compare === "year") return { qs: `${dates}&compare=year`, label: `${label} against the previous year` };
  if (c.compare === "custom") return { qs: `${dates}&compare=custom&cfrom=${c.cfrom}&cto=${c.cto}`, label: `${label} against ${fmtSpan(c.cfrom, c.cto, { year: true })}` };
  return { qs: dates, label };
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
 * The dates the dashboard reports on, and what their changes compare with. `start` is the store's
 * first day (`startDay`: when Shopify created it, or an earlier order's): All time starts on it,
 * and once Shopify's creation date is known (`created`) custom dates can't start before it, as the
 * API checks (`storeRangeLimits`).
 *
 * `asking` is the question to send. Custom dates (to report on or to compare with) only take over
 * once they are finished and valid: asking for each half-typed one (a year arrives as 0002, 0020,
 * 0202…) flashed an error per digit. Until then the last good question stays live instead of the
 * page stalling on "Checking".
 *
 * The choice is kept in the address bar and for the rest of the tab's session, so a reload, the
 * back button, a shared link or a trip to Settings and back no longer drops it to the last 30 days.
 * `asking` stays null until that has been read, so the page doesn't first load the default dates.
 */
export function useDateRange(timeZone: string, start: string | null = null, created = false) {
  const [choice, setChoice] = useState<Choice>({ preset: "30d", from: "", to: "", compare: "previous", cfrom: "", cto: "" });
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState<Question>(DEFAULT);
  // The store's today: custom dates can't start after it, and are reported up to it at most.
  const today = storeToday(timeZone);
  // The same limits the API checks: from the store's first day, any length.
  const limits = storeRangeLimits(start, created);
  const problem = choice.preset === "custom" ? customRangeProblem(choice, today, limits) : null;
  // All time has nothing before it to compare with: its comparison isn't asked about.
  const compareProblem = choice.compare === "custom" && choice.preset !== "all" ? customRangeProblem({ from: choice.cfrom, to: choice.cto }, today, limits) : null;

  if (restored) {
    const q = questionOf(choice);
    if (!problem && !compareProblem) {
      if (q.qs !== asking.qs) setAsking(q);
    } else if (q.qs === asking.qs) {
      // Dates asked for before the store's limits were known (a link, the tab's last dates, another
      // store's) that turn out to lie outside them: the default dates, never a question the API refuses.
      setAsking(DEFAULT);
    }
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
    setChoice((c) => (preset === "custom" && !c.from && !c.to && shown ? { ...c, preset, ...shown } : { ...c, preset }));
  /** The same for the comparison: custom starts from the dates the numbers are compared with now. */
  const chooseCompare = (compare: CompareMode, shown?: DateRange) =>
    setChoice((c) => (compare === "custom" && !c.cfrom && !c.cto && shown ? { ...c, compare, cfrom: shown.from, cto: shown.to } : { ...c, compare }));

  return {
    ...choice,
    today,
    // How early the date boxes go: the store's first day once Shopify's creation date is known.
    earliest: limits.earliest ?? null,
    problem,
    compareProblem,
    asking: restored ? asking : null,
    choose,
    chooseCompare,
    setFrom: (from: string) => setChoice((c) => ({ ...c, from })),
    setTo: (to: string) => setChoice((c) => ({ ...c, to })),
    setCompareFrom: (cfrom: string) => setChoice((c) => ({ ...c, cfrom })),
    setCompareTo: (cto: string) => setChoice((c) => ({ ...c, cto })),
  };
}

export type DateRangeState = ReturnType<typeof useDateRange>;

/**
 * What the numbers are compared with, as the API answers it: `compare` says how it was chosen, and
 * `imported` is false when the store's imported orders don't reach back to it (no change is given).
 */
export type ShownComparison = Comparison & { compare?: CompareMode; imported?: boolean };

/**
 * What the numbers on the page are for, once they have loaded. `start` is the store's first day
 * (the overview's `data.startDay`), when known.
 */
export type Shown = { range: DateRange; previous: ShownComparison; timezone: string; start?: string | null } | null;

/** Whether the comparison lies wholly before the store's first day (All time's always does): nothing to compare with. */
const beforeStore = (shown: Shown) => !!shown?.start && shown.previous.to < shown.start;

/** The dates compared with, with their year unless they are just before the dates picked. */
const comparisonDates = (p: ShownComparison) => (p.compare && p.compare !== "previous" ? fmtSpan(p.from, p.to, { year: true }) : fmtSpan(p.from, p.to));

/**
 * "Compared with 18 Aug – 16 Sep" for a tooltip, once the numbers have loaded; "Compared with
 * 16 Oct until 4:44 pm, the same time of day" while the dates picked are still running.
 */
export const comparedWith = (shown: Shown) => {
  if (!shown) return undefined;
  if (beforeStore(shown)) return `Nothing to compare with: the store's data starts on ${fmtDay(shown.start)}`;
  const p = shown.previous;
  const cut = p.until ? ` until ${fmtClock(p.until)}, the same time of day` : "";
  const missing = p.imported === false ? ". No orders were imported from that far back, so nothing is compared" : "";
  return `Compared with ${comparisonDates(p)}${cut}${missing}`;
};

const wholeYear = (r: DateRange) => r.from.endsWith("-01-01") && r.to.endsWith("-12-31") && r.from.slice(0, 4) === r.to.slice(0, 4);

/**
 * What a change is on, short enough for under a headline number: "vs same time yesterday",
 * "vs 17 Oct", "vs previous 30 days", "vs same day last year", "vs 14 Mar 2026". Last month is
 * compared with the whole month before it, whatever its length.
 */
export function versusWords(shown: { range: DateRange; previous: ShownComparison } | null): string {
  if (!shown) return "vs previous period";
  const { range, previous: p } = shown;
  const days = daysBetweenInclusive(range.from, range.to);
  if (p.compare === "year") return days === 1 ? "vs same day last year" : "vs same dates last year";
  if (p.compare === "custom") return `vs ${comparisonDates(p)}`;
  // A finished day names the day it is compared with: "the day before" left it to be worked out,
  // next to a Shopify screen comparing with a date of its own.
  if (days === 1) return p.until ? "vs same time yesterday" : `vs ${fmtDay(p.from, { year: false })}`;
  // Last year is compared with the whole year before, leap or not; last month with the whole month before.
  if (wholeYear(range) && wholeYear(p)) return "vs the year before";
  if (daysBetweenInclusive(p.from, p.to) !== days) return "vs the month before";
  return `vs previous ${days} days`;
}

/**
 * What the numbers are compared with, for a panel's help line: "17 Oct 2025 until 4:44 pm, the
 * same dates a year earlier, up to the same time of day, as Shopify compares".
 */
export function comparisonHelp(p: ShownComparison): string {
  const how = p.compare === "year" ? ", the same dates a year earlier" : p.compare === "custom" ? "" : ", the same number of days just before";
  return `${fmtComparison(p)}${how}${p.until ? ", up to the same time of day, as Shopify compares" : ""}`;
}

/** What has its own history on the dashboard: each is compared only with dates from its start. */
export type HistorySource = "sales" | "visits" | "ads" | "adsense";

/**
 * Why figures aren't compared when their history doesn't reach back to the comparison
 * (`previous.imported` false). `historyFrom` is the first day they were all recorded from: the
 * overview's `data.historyFrom` for sales (absent for a member who may not see orders), the
 * funnel's or the ad module's own for visits and ads.
 */
export function noEarlierData(historyFrom: string | null | undefined, source: HistorySource = "sales"): string {
  const day = historyFrom ? fmtDay(historyFrom) : null;
  switch (source) {
    case "visits":
      return day
        ? `No earlier data: the bizinsights pixel has counted visits since ${day}, so visits aren't compared with dates before that.`
        : "No earlier data: no visits were counted on those dates, so visits aren't compared.";
    case "ads":
    case "adsense": {
      const what = source === "ads" ? "ad figures" : "AdSense figures";
      return day
        ? `No earlier data: bizinsights has your ${what} from ${day} on, so they aren't compared with dates before that. A new account brings its last 90 days first, then earlier days back to 25 months, a few months at a time.`
        : `No earlier data: your ${source === "ads" ? "ad accounts haven't" : "AdSense account hasn't"} been read yet, so nothing is compared.`;
    }
    default: {
      const start = day ? `Shopify shared orders from ${day} on, so sales aren't compared with dates before that` : "no orders were imported from those dates, so sales aren't compared";
      return `No earlier data: ${start}. Without access to all orders, Shopify shares only the last 60 days.`;
    }
  }
}

/**
 * A pill naming a choice, with the native select laid over it, so it opens the system's own list
 * and keyboards and screen readers get a real select. `label` names it for them.
 */
function PillSelect<T extends string>({
  id,
  label,
  icon: IconCmp,
  text,
  title,
  size,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  text: ReactNode;
  title?: string;
  size: "sm" | "md";
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className={`relative inline-flex min-w-0 items-center gap-2 rounded-xl border border-border bg-surface font-medium shadow-[var(--shadow)] transition-colors focus-within:ring-2 focus-within:ring-accent hover:border-accent/40 ${
        size === "sm" ? "h-9 pl-3 pr-8 text-xs" : "h-10 pl-3.5 pr-10 text-sm"
      }`}
      title={title}
    >
      {size === "md" && <IconCmp aria-hidden className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.8} />}
      <span aria-hidden className="truncate">{text}</span>
      <ChevronDown aria-hidden className={`pointer-events-none absolute h-4 w-4 text-muted ${size === "sm" ? "right-2.5" : "right-3.5"}`} />
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.id === "custom" ? "Pick dates…" : o.label}</option>
        ))}
      </select>
    </div>
  );
}

/** The dates menu. The page has one "Dates" menu, and the summary card repeats it as "Period". */
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
    <PillSelect
      id={id}
      label={label}
      icon={CalendarDays}
      text={text}
      title={shown ? `${fmtSpan(shown.range.from, shown.range.to)}. ${comparedWith(shown)}. Days follow the store's time zone (${shown.timezone}).` : undefined}
      size={size}
      value={r.preset}
      options={PRESETS}
      onChange={(p) => r.choose(p, shown?.range)}
    />
  );
}

/**
 * The comparison menu beside the dates: what the ▲ ▼ changes are on, as Shopify's second date chip.
 *
 * Like that chip it names the dates compared with ("vs 17 Oct 2026"), not only how they were
 * chosen: "vs Previous period" beside a Shopify screen comparing with 14 Mar read as the same
 * comparison, and the two sets of changes as a mismatch. `current` is false while the answer
 * on screen is still the one for the dates picked before, whose comparison it would name; the
 * pill then says how the comparison is chosen until the new answer lands.
 */
export function CompareSelect({
  r,
  shown,
  current = true,
  id,
  label,
  size = "md",
}: {
  r: DateRangeState;
  shown: Shown;
  current?: boolean;
  id: string;
  label: string;
  size?: "sm" | "md";
}) {
  if (r.preset === "all") {
    // All time starts on the store's first day: there is no earlier period of the same kind.
    return (
      <span
        className={`inline-flex min-w-0 items-center gap-2 rounded-xl border border-dashed border-border font-medium text-muted ${size === "sm" ? "h-9 px-3 text-xs" : "h-10 px-3.5 text-sm"}`}
        title="All time starts on the store's first day, so there is nothing earlier to compare it with."
        data-testid="compare-dates"
      >
        {size === "md" && <ArrowLeftRight aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.8} />}
        No comparison
      </span>
    );
  }
  const mode = COMPARISONS.find((c) => c.id === r.compare)!.label;
  const answered = current && shown && (shown.previous.compare ?? "previous") === r.compare ? shown.previous : null;
  const text =
    r.compare === "custom"
      ? r.cfrom && r.cto && !r.compareProblem
        ? fmtSpan(r.cfrom, r.cto, { year: true })
        : "Pick dates"
      : answered
        ? fmtSpan(answered.from, answered.to, { year: true })
        : mode;
  return (
    <PillSelect
      id={id}
      label={label}
      icon={ArrowLeftRight}
      text={
        <span data-testid="compare-dates">
          <span className="font-normal text-muted">vs </span>
          {text}
        </span>
      }
      title={answered && r.compare !== "custom" ? `${mode}. ${comparedWith(shown)}` : comparedWith(shown)}
      size={size}
      value={r.compare}
      options={COMPARISONS}
      onChange={(c) => r.chooseCompare(c, shown?.previous)}
    />
  );
}

/**
 * Two date boxes, and what is wrong with them while they don't make a range yet. They offer no day
 * before the store's first (`min`), as far as the browser's own calendar allows; a date typed
 * before it anyway is named by the hint and never asked for.
 */
function DatePair({
  labels,
  from,
  to,
  min,
  max,
  problem,
  setFrom,
  setTo,
}: {
  labels: [from: string, to: string];
  from: string;
  to: string;
  min: string | null;
  max: string;
  problem: CustomRangeProblem | null;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <input aria-label={labels[0]} type="date" min={min ?? MIN_CUSTOM_DAY} max={max} className="input w-auto py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
        to
        <input aria-label={labels[1]} type="date" min={min ?? MIN_CUSTOM_DAY} max={max} className="input w-auto py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
      </span>
      {problem && <p className={`text-xs ${problem === "incomplete" ? "text-muted" : "text-warn"}`} role="status">{customHint(problem, min)}</p>}
    </div>
  );
}

/** With "Pick dates…" chosen: the two date boxes. */
export function CustomDates({ r }: { r: DateRangeState }) {
  if (r.preset !== "custom") return null;
  return <DatePair labels={["From", "To"]} from={r.from} to={r.to} min={r.earliest} max={r.today} problem={r.problem} setFrom={r.setFrom} setTo={r.setTo} />;
}

/** With "Pick dates…" chosen to compare with: its two date boxes, named so they aren't mistaken for the dates reported on. */
export function CompareDates({ r }: { r: DateRangeState }) {
  if (r.compare !== "custom" || r.preset === "all") return null;
  return (
    <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1">
      <span className="py-1.5 text-sm text-muted">Compare with</span>
      <DatePair labels={["Compare from", "Compare to"]} from={r.cfrom} to={r.cto} min={r.earliest} max={r.today} problem={r.compareProblem} setFrom={r.setCompareFrom} setTo={r.setCompareTo} />
    </div>
  );
}

/** "15 March 2022": a day written out in full, for the line that states the dates. */
function fmtFullDay(day: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * The line under the dashboard's heading that says exactly what the numbers cover: "Store created:
 * 15 March 2022 · Showing data: 15 March 2022 – 23 October 2026", days in the store's time zone. When
 * the dates reach back before the orders Shopify shared (`historyFrom`: 60 days without access to
 * all orders), it says from when the figures really count, so days with nothing imported never
 * read as days without sales.
 */
export function RangeLabel({ shown, createdDay, historyFrom }: { shown: Shown; createdDay: string | null | undefined; historyFrom: string | null | undefined }) {
  if (!shown) return null;
  const { range } = shown;
  const showing = range.from === range.to ? fmtFullDay(range.from) : `${fmtFullDay(range.from)} – ${fmtFullDay(range.to)}`;
  const from = historyFrom && range.from < historyFrom ? historyFrom : null;
  return (
    <div className="space-y-0.5 text-xs text-muted" data-testid="range-label">
      <p>
        {createdDay && (
          <>
            <span data-testid="store-created">
              Store created: <span className="font-medium text-text">{fmtFullDay(createdDay)}</span>
            </span>
            <span aria-hidden> · </span>
          </>
        )}
        <span data-testid="showing-dates">
          Showing data: <span className="font-medium text-text">{showing}</span>
        </span>
        <span className="whitespace-nowrap"> ({shown.timezone})</span>
      </p>
      {from && (
        <p className="text-warn" data-testid="range-before-history">
          {range.to < from
            ? `No orders from these dates were imported: Shopify shared orders from ${fmtFullDay(from)} on.`
            : `Order figures count from ${fmtFullDay(from)}: Shopify shared orders from then on.`}{" "}
          Without access to all orders, Shopify shares only the last 60 days.
        </p>
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
    case "wtd":
      return "this week";
    case "all":
      return shown ? `since ${fmtDay(shown.range.from)}` : "since the store was created";
    case "mtd":
      return "this month";
    case "lastmonth":
      return "last month";
    case "ytd":
      return "this year";
    case "lastyear":
      return "last year";
    case "custom":
      return shown ? (shown.range.from === shown.range.to ? `on ${fmtDay(shown.range.from)}` : `from ${fmtSpan(shown.range.from, shown.range.to)}`) : "in the dates you picked";
    default:
      return `in the ${PRESETS.find((p) => p.id === r.preset)!.label.toLowerCase()}`;
  }
}
