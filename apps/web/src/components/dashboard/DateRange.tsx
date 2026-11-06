"use client";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftRight, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  addDays,
  calendarYear,
  customRangeProblem,
  daysBetweenInclusive,
  isDay,
  latestRangeEnd,
  localDay,
  MIN_CUSTOM_DAY,
  monthsEarlier,
  storeRangeLimits,
  yearEarlier,
  yearsBetween,
  type CompareMode,
  type Comparison,
  type CustomRangeProblem,
  type DatePreset,
  type DateRange,
} from "@app/shared/dates";
import { fmtClock, fmtComparison, fmtDay, fmtRange, fmtSpan } from "./format";

/**
 * The dates menu. `option` is the menu's longer wording where the pill's short label leaves a
 * question open: which day weeks start on (Monday, `WEEK_STARTS_ON` in @app/shared).
 */
export const PRESETS: ReadonlyArray<{ id: DatePreset; label: string; option?: string }> = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "wtd", label: "This week", option: "This week (Mon – today)" },
  { id: "lastweek", label: "Last week", option: "Last week (Mon – Sun)" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "6m", label: "Last 6 months" },
  { id: "12m", label: "Last 12 months" },
  { id: "mtd", label: "This month" },
  { id: "lastmonth", label: "Last month" },
  { id: "ytd", label: "This year" },
  { id: "lastyear", label: "Last year" },
  { id: "custom", label: "Custom" },
];
export type PresetId = DatePreset;

/** What the changes compare with, as Shopify Analytics' second date chip offers (`COMPARE_MODES` in @app/shared). */
export const COMPARISONS: ReadonlyArray<{ id: CompareMode; label: string }> = [
  { id: "previous", label: "Previous period" },
  { id: "year", label: "Previous year" },
  { id: "custom", label: "Custom" },
];

/** What is wrong with dates picked, in the words of the person picking them. */
function customHint(problem: CustomRangeProblem, from: string, startDay: string | null): string {
  switch (problem) {
    case "incomplete":
      return "Pick a start and an end date.";
    case "reversed":
      return "The start date is after the end date.";
    case "future":
      return "The start date hasn't happened yet in the store's time zone.";
    case "before_start":
      return startDay ? `The store's first day is ${fmtDay(startDay)}: pick a start date from then on.` : "Pick a start date from the store's first day on.";
    case "too_long":
      // Older years are just as available: only the length is limited.
      return `Pick up to 12 months at a time: from ${fmtDay(from)}, the latest end date is ${fmtDay(latestRangeEnd(from))}.`;
  }
}

/** The menu's value for a calendar year picked from it (`yearChoice`). */
const yearId = (year: number) => `year-${year}`;

/**
 * What a question looks like in the address bar and in the API call: `preset=7d`,
 * `preset=custom&from=…&to=…`, then `&compare=year` or `&compare=custom&cfrom=…&cto=…` when the
 * changes aren't on the period just before.
 */
type Question = { qs: string; label: string };
const DEFAULT: Question = { qs: "preset=30d", label: "Last 30 days" };
const PARAMS = ["preset", "from", "to", "compare", "cfrom", "cto"] as const;

/**
 * Where the store's dates begin, as far as the page knows: its first day (`storeStartDay` in
 * @app/shared, from the store list, so it is known before the numbers load), and whether that is
 * Shopify's creation date, which custom dates may not start before (`storeRangeLimits`). The API
 * checks the same limits; this only lets the page say so before asking.
 */
export type StoreStart = { day: string | null; created: boolean };

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
 * The dates the dashboard reports on, and what their changes compare with.
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
export function useDateRange(timeZone: string, start: StoreStart = { day: null, created: false }) {
  const [choice, setChoice] = useState<Choice>({ preset: "30d", from: "", to: "", compare: "previous", cfrom: "", cto: "" });
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState<Question>(DEFAULT);
  // The store's today: custom dates can't start after it, and are reported up to it at most.
  const today = storeToday(timeZone);
  const limits = storeRangeLimits(start.day, start.created);
  const problem = choice.preset === "custom" ? customRangeProblem(choice, today, limits) : null;
  const compareProblem = choice.compare === "custom" ? customRangeProblem({ from: choice.cfrom, to: choice.cto }, today) : null;

  if (restored && !problem && !compareProblem) {
    const q = questionOf(choice);
    if (q.qs !== asking.qs) setAsking(q);
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
  /** A calendar year, 1 January to 31 December (to today for this year): any year, however long ago. */
  const chooseYear = (year: number) => setChoice((c) => ({ ...c, preset: "custom", ...calendarYear(year, today) }));
  /**
   * The custom dates a year earlier or later (`by` -1 or 1), so the same months of another year are
   * one click away; null when that year can't be reported on (it hasn't started, or the store hadn't).
   */
  const yearShift = (by: -1 | 1): DateRange | null => {
    if (choice.preset !== "custom" || problem) return null;
    const move = (d: string) => (by < 0 ? yearEarlier(d) : monthsEarlier(d, -12));
    const next = { from: move(choice.from), to: move(choice.to) };
    return customRangeProblem(next, today, limits) ? null : next;
  };
  const shiftYear = (by: -1 | 1) => {
    const next = yearShift(by);
    if (next) setChoice((c) => ({ ...c, ...next }));
  };

  return {
    ...choice,
    today,
    start,
    problem,
    compareProblem,
    asking: restored ? asking : null,
    choose,
    chooseCompare,
    chooseYear,
    yearShift,
    shiftYear,
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

/** What the numbers on the page are for, once they have loaded. */
export type Shown = { range: DateRange; previous: ShownComparison; timezone: string } | null;

/** The dates compared with, with their year unless they are just before the dates picked. */
const comparisonDates = (p: ShownComparison) => (p.compare && p.compare !== "previous" ? fmtSpan(p.from, p.to, { year: true }) : fmtSpan(p.from, p.to));

/**
 * "Compared with 18 Aug – 16 Sep" for a tooltip, once the numbers have loaded; "Compared with
 * 16 Oct until 4:44 pm, the same time of day" while the dates picked are still running.
 */
export const comparedWith = (shown: Shown) => {
  if (!shown) return undefined;
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
  // This week so far is compared with the same weekdays of the week before (Monday on).
  if (p.from === addDays(range.from, -7) && p.to === addDays(range.to, -7) && days < 7) return p.until ? "vs same time last week" : "vs same days last week";
  if (days === 1) return p.until ? "vs same time yesterday" : `vs ${fmtDay(p.from, { year: false })}`;
  // Last year is compared with the whole year before, leap or not; last month with the whole month before.
  if (wholeYear(range) && wholeYear(p)) return "vs the year before";
  if (daysBetweenInclusive(p.from, p.to) !== days) return "vs the month before";
  if (days === 7 && new Date(`${range.from}T00:00:00Z`).getUTCDay() === 1 && p.to === addDays(range.from, -1)) return "vs the week before";
  return `vs previous ${days} days`;
}

/**
 * What the numbers are compared with, for a panel's help line: "17 Oct 2025 until 4:44 pm, the
 * same dates a year earlier, up to the same time of day, as Shopify compares".
 */
export function comparisonHelp(p: ShownComparison, range?: DateRange): string {
  const sameWeekdays = range && p.from === addDays(range.from, -7) && p.to === addDays(range.to, -7) && daysBetweenInclusive(range.from, range.to) < 7;
  const how =
    p.compare === "year" ? ", the same dates a year earlier" : p.compare === "custom" ? "" : sameWeekdays ? ", the same weekdays of the week before" : ", the same number of days just before";
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
  groups = [],
  onChange,
}: {
  id: string;
  label: string;
  icon: LucideIcon;
  text: ReactNode;
  title?: string;
  size: "sm" | "md";
  value: T;
  options: ReadonlyArray<{ id: T; label: string; option?: string }>;
  /** More choices after `options`, under a heading each (the dates menu's calendar years). */
  groups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ id: T; label: string }> }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className={`relative inline-flex min-w-0 items-center gap-2 rounded-lg border border-transparent bg-surface font-medium shadow-[var(--shadow)] transition-colors focus-within:ring-2 focus-within:ring-accent hover:bg-home-soft ${
        size === "sm" ? "h-9 pl-3 pr-8 text-xs" : "h-10 pl-3.5 pr-10 text-sm"
      }`}
      title={title}
    >
      {size === "md" && <IconCmp aria-hidden className="h-4 w-4 shrink-0 text-muted" strokeWidth={1.8} />}
      <span aria-hidden className="truncate">{text}</span>
      <ChevronDown aria-hidden className={`pointer-events-none absolute h-4 w-4 text-muted ${size === "sm" ? "right-2.5" : "right-3.5"}`} />
      <SelectOver id={id} label={label} value={value} options={options} groups={groups} onChange={onChange} />
    </div>
  );
}

type Choices<T extends string> = {
  options: ReadonlyArray<{ id: T; label: string; option?: string }>;
  groups?: ReadonlyArray<{ label: string; options: ReadonlyArray<{ id: T; label: string }> }>;
};

/** The native select, invisible over whatever names its choice (its nearest positioned parent). */
function SelectOver<T extends string>({ id, label, value, options, groups = [], onChange }: { id: string; label: string; value: T; onChange: (value: T) => void } & Choices<T>) {
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select id={id} className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.id === "custom" ? "Pick dates…" : (o.option ?? o.label)}</option>
        ))}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </>
  );
}

/**
 * The calendar years the dates menu offers, newest first: from the year Shopify created the store to
 * this one, years whose orders Shopify hasn't shared included (the page says so, rather than the
 * menu hiding them). While the creation date isn't known: the last five years, or back to the first
 * order held when that is older.
 */
function menuYears(r: DateRangeState): number[] {
  const fallback = `${Number(r.today.slice(0, 4)) - 4}-01-01`;
  const first = r.start.created && r.start.day ? r.start.day : r.start.day && r.start.day < fallback ? r.start.day : fallback;
  return yearsBetween(first, r.today);
}

/** The year the custom dates are, when they are exactly one calendar year (this year: up to today or its end). */
function yearChoice(r: DateRangeState): number | null {
  if (r.preset !== "custom" || r.problem) return null;
  const year = r.from.slice(0, 4);
  return r.from === `${year}-01-01` && (r.to === `${year}-12-31` || r.to === calendarYear(Number(year), r.today).to) ? Number(year) : null;
}

/**
 * The dates menu. The page has one "Dates" menu, and the summary card repeats it as "Period". Below
 * the presets it lists every calendar year of the store: each is 12 months, and a year long past is
 * asked about like this one.
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
  const d = datesChoice(r, shown);
  return <PillSelect<string> id={id} label={label} icon={CalendarDays} text={d.text} title={d.title} size={size} {...d.select} />;
}

/** What the dates menu shows and offers: "Last 30 days", "2025", "1 Mar – 8 Mar 2026". */
function datesChoice(r: DateRangeState, shown: Shown) {
  const year = yearChoice(r);
  const text =
    year !== null
      ? String(year)
      : r.preset !== "custom"
        ? PRESETS.find((p) => p.id === r.preset)!.label
        : r.from && r.to && !r.problem
          ? fmtRange(r.from, r.to)
          : "Pick dates";
  return {
    text,
    /** A preset's name is followed by its dates, "(7 Oct – 5 Nov)": a custom range or a year already says them. */
    named: year === null && r.preset !== "custom",
    title: shown ? `${fmtSpan(shown.range.from, shown.range.to)}. ${comparedWith(shown)}. Days follow the store's time zone (${shown.timezone}); weeks run Monday to Sunday.` : undefined,
    select: {
      value: year !== null ? yearId(year) : r.preset,
      options: PRESETS,
      groups: [{ label: "Calendar years", options: menuYears(r).map((y) => ({ id: yearId(y), label: String(y) })) }],
      onChange: (v: string) => {
        if (v.startsWith("year-")) r.chooseYear(Number(v.slice(5)));
        else r.choose(v as PresetId, shown?.range);
      },
    },
  };
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
  const c = compareChoice(r, shown, current);
  return (
    <PillSelect
      id={id}
      label={label}
      icon={ArrowLeftRight}
      text={
        <span data-testid="compare-dates">
          <span className="font-normal text-muted">vs </span>
          {c.text}
        </span>
      }
      title={c.title}
      size={size}
      {...c.select}
    />
  );
}

/** What the comparison menu shows ("17 Oct 2026", or how it is chosen while that isn't known) and offers. */
function compareChoice(r: DateRangeState, shown: Shown, current: boolean) {
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
  return {
    text,
    title: answered && r.compare !== "custom" ? `${mode}. ${comparedWith(shown)}` : comparedWith(shown),
    select: { value: r.compare, options: COMPARISONS, onChange: (c: CompareMode) => r.chooseCompare(c, shown?.previous) },
  };
}

/**
 * The simple Home's dates (the Stitch design): one card, the dates on top ("Last 30 days (7 Oct –
 * 5 Nov)") and what they are compared with under them ("vs 7 Sep – 6 Oct"). Each line is the page's
 * own menu laid over it (ids `date-range` and `compare-with`), so it opens the same choices as the
 * full dashboard's two pills.
 */
export function DateChip({ r, shown, current = true }: { r: DateRangeState; shown: Shown; current?: boolean }) {
  const d = datesChoice(r, shown);
  const c = compareChoice(r, shown, current);
  const line = "relative block min-w-0 rounded-sm focus-within:ring-2 focus-within:ring-accent";
  return (
    <div className="home-card relative inline-flex min-w-0 max-w-full items-center gap-3 py-2 pr-9 pl-3 transition-colors hover:bg-home-soft" title={d.title} data-testid="date-chip">
      <CalendarDays aria-hidden className="h-[18px] w-[18px] shrink-0 text-muted" strokeWidth={1.8} />
      <span className="flex min-w-0 flex-col">
        <span className={line}>
          <span aria-hidden className="block truncate text-[13px] leading-4 font-medium">
            {d.text}
            {d.named && shown && <span className="hidden sm:inline"> ({fmtSpan(shown.range.from, shown.range.to)})</span>}
          </span>
          <SelectOver<string> id="date-range" label="Dates" {...d.select} />
        </span>
        <span className={`${line} mt-0.5`} title={c.title}>
          <span aria-hidden className="block truncate text-xs leading-4 text-muted" data-testid="compare-dates">
            vs {c.text}
          </span>
          <SelectOver id="compare-with" label="Compare with" {...c.select} />
        </span>
      </span>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 h-[18px] w-[18px] text-muted" />
    </div>
  );
}

/**
 * Two date boxes, and what is wrong with them while they don't make a range yet. The end box's
 * calendar stops 12 months after the start (and at today), so a range too long can't be picked
 * there; typed, it says so.
 */
function DatePair({
  labels,
  from,
  to,
  min,
  max,
  problem,
  startDay,
  setFrom,
  setTo,
}: {
  labels: [from: string, to: string];
  from: string;
  to: string;
  min: string;
  max: string;
  problem: CustomRangeProblem | null;
  startDay: string | null;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
}) {
  const started = isDay(from) && from >= MIN_CUSTOM_DAY;
  const toMax = started && latestRangeEnd(from) < max ? latestRangeEnd(from) : max;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <span className="flex flex-wrap items-center justify-end gap-2 text-sm">
        <input aria-label={labels[0]} type="date" min={min} max={max} className="input w-auto py-1.5" value={from} onChange={(e) => setFrom(e.target.value)} />
        to
        <input aria-label={labels[1]} type="date" min={started && from > min ? from : min} max={toMax} className="input w-auto py-1.5" value={to} onChange={(e) => setTo(e.target.value)} />
      </span>
      {problem && (
        <p className={`text-xs ${problem === "incomplete" ? "text-muted" : "text-warn"}`} role="status">
          {customHint(problem, from, startDay)}
        </p>
      )}
    </div>
  );
}

const shiftButton =
  "inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-text disabled:cursor-not-allowed disabled:opacity-40";

/**
 * With "Pick dates…" chosen (or a calendar year from the menu): the two date boxes, and the same
 * dates a year earlier or later, so 2023 against 2024, or one March against another, is a click away.
 */
export function CustomDates({ r }: { r: DateRangeState }) {
  if (r.preset !== "custom") return null;
  const earlier = r.yearShift(-1);
  const later = r.yearShift(1);
  const min = r.start.created && r.start.day ? r.start.day : MIN_CUSTOM_DAY;
  return (
    <div className="flex flex-wrap items-start justify-end gap-x-3 gap-y-2">
      <span className="flex items-center gap-1.5 py-0.5" role="group" aria-label="Move by a year">
        <button type="button" className={shiftButton} disabled={!earlier} onClick={() => r.shiftYear(-1)} title={earlier ? fmtRange(earlier.from, earlier.to) : "Nothing earlier to show"}>
          <ChevronLeft aria-hidden className="h-3.5 w-3.5" /> A year earlier
        </button>
        <button type="button" className={shiftButton} disabled={!later} onClick={() => r.shiftYear(1)} title={later ? fmtRange(later.from, later.to) : "Those dates haven't started yet"}>
          A year later <ChevronRight aria-hidden className="h-3.5 w-3.5" />
        </button>
      </span>
      <DatePair labels={["From", "To"]} from={r.from} to={r.to} min={min} max={r.today} problem={r.problem} startDay={r.start.day} setFrom={r.setFrom} setTo={r.setTo} />
    </div>
  );
}

/** With "Pick dates…" chosen to compare with: its two date boxes, named so they aren't mistaken for the dates reported on. */
export function CompareDates({ r }: { r: DateRangeState }) {
  if (r.compare !== "custom") return null;
  return (
    <div className="flex flex-wrap items-start justify-end gap-x-2 gap-y-1">
      <span className="py-1.5 text-sm text-muted">Compare with</span>
      <DatePair
        labels={["Compare from", "Compare to"]}
        from={r.cfrom}
        to={r.cto}
        min={MIN_CUSTOM_DAY}
        max={r.today}
        problem={r.compareProblem}
        startDay={r.start.day}
        setFrom={r.setCompareFrom}
        setTo={r.setCompareTo}
      />
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
    case "lastweek":
      return "last week";
    case "mtd":
      return "this month";
    case "lastmonth":
      return "last month";
    case "ytd":
      return "this year";
    case "lastyear":
      return "last year";
    case "custom": {
      if (!shown) return "in the dates you picked";
      const { from, to } = shown.range;
      // An older year says which: "from 1 Jan – 31 Dec" alone read as this year.
      return from === to ? `on ${fmtDay(from)}` : `from ${fmtSpan(from, to, { year: to.slice(0, 4) !== r.today.slice(0, 4) })}`;
    }
    default:
      return `in the ${PRESETS.find((p) => p.id === r.preset)!.label.toLowerCase()}`;
  }
}
