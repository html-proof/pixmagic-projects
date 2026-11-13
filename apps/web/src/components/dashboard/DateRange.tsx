"use client";
import { useEffect, useState, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import {
  calendarYear,
  customRangeProblem,
  isDay,
  latestRangeEnd,
  localDay,
  MIN_CUSTOM_DAY,
  monthsEarlier,
  storeRangeLimits,
  yearEarlier,
  yearsBetween,
  type CustomRangeProblem,
  type DatePreset,
  type DateRange,
} from "@app/shared/dates";
import { fmtDay, fmtRange, fmtSpan } from "./format";

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
 * `preset=custom&from=…&to=…`. The changes are always on the period just before the dates.
 */
type Question = { qs: string; label: string };
const DEFAULT: Question = { qs: "preset=30d", label: "Last 30 days" };
/**
 * `compare`, `cfrom` and `cto` chose what the dates were compared with, while that could be chosen:
 * an old link or bookmark still carries them, and they are taken out of the address bar with the rest.
 */
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

type Choice = { preset: PresetId; from: string; to: string };

function parseChoice(search: string | null): Choice | null {
  if (!search) return null;
  const q = new URLSearchParams(search);
  const preset = PRESETS.find((p) => p.id === q.get("preset"))?.id;
  if (!preset) return null;
  const from = q.get("from");
  const to = q.get("to");
  if (preset === "custom" && !(isDay(from) && isDay(to))) return null;
  return preset === "custom" ? { preset, from: from!, to: to! } : { preset, from: "", to: "" };
}

/** The question a finished, valid choice asks. */
function questionOf(c: Choice): Question {
  return c.preset === "custom"
    ? { qs: `preset=custom&from=${c.from}&to=${c.to}`, label: fmtRange(c.from, c.to) }
    : { qs: `preset=${c.preset}`, label: PRESETS.find((p) => p.id === c.preset)!.label };
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
 * The dates the dashboard reports on. Their changes are on the period just before them.
 *
 * `asking` is the question to send. Custom dates only take over once they are finished and valid:
 * asking for each half-typed one (a year arrives as 0002, 0020, 0202…) flashed an error per digit.
 * Until then the last good question stays live instead of the page stalling on "Checking".
 *
 * The choice is kept in the address bar and for the rest of the tab's session, so a reload, the
 * back button, a shared link or a trip to Settings and back no longer drops it to the last 30 days.
 * `asking` stays null until that has been read, so the page doesn't first load the default dates.
 */
export function useDateRange(timeZone: string, start: StoreStart = { day: null, created: false }) {
  const [choice, setChoice] = useState<Choice>({ preset: "30d", from: "", to: "" });
  const [restored, setRestored] = useState(false);
  const [asking, setAsking] = useState<Question>(DEFAULT);
  // The store's today: custom dates can't start after it, and are reported up to it at most.
  const today = storeToday(timeZone);
  const limits = storeRangeLimits(start.day, start.created);
  const problem = choice.preset === "custom" ? customRangeProblem(choice, today, limits) : null;

  if (restored && !problem) {
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
    asking: restored ? asking : null,
    choose,
    chooseYear,
    yearShift,
    shiftYear,
    setFrom: (from: string) => setChoice((c) => ({ ...c, from })),
    setTo: (to: string) => setChoice((c) => ({ ...c, to })),
  };
}

export type DateRangeState = ReturnType<typeof useDateRange>;

/** What the numbers on the page are for, once they have loaded. */
export type Shown = { range: DateRange; timezone: string } | null;

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
    title: shown ? `${fmtSpan(shown.range.from, shown.range.to)}. Days follow the store's time zone (${shown.timezone}); weeks run Monday to Sunday.` : undefined,
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
 * The dates as one card on the sales pages (the Stitch design): "Last 30 days (7 Oct – 5 Nov)",
 * with the page's own dates menu laid over it (id `date-range`), so it opens the same choices as
 * the full dashboard's pill.
 */
export function DateChip({ r, shown }: { r: DateRangeState; shown: Shown }) {
  const d = datesChoice(r, shown);
  return (
    <div
      className="home-card relative inline-flex min-w-0 max-w-full items-center gap-3 py-2.5 pr-9 pl-3 transition-colors focus-within:ring-2 focus-within:ring-accent hover:bg-home-soft"
      title={d.title}
      data-testid="date-chip"
      data-tour="dates"
    >
      <CalendarDays aria-hidden className="h-[18px] w-[18px] shrink-0 text-muted" strokeWidth={1.8} />
      <span aria-hidden className="block min-w-0 truncate text-[13px] leading-4 font-medium">
        {d.text}
        {d.named && shown && <span className="hidden sm:inline"> ({fmtSpan(shown.range.from, shown.range.to)})</span>}
      </span>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 h-[18px] w-[18px] text-muted" />
      <SelectOver<string> id="date-range" label="Dates" {...d.select} />
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
