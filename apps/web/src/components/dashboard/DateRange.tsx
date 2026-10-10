"use client";
import { useEffect, useState } from "react";
import { customRangeProblem, isDay, localDay, MIN_CUSTOM_DAY, type CustomRangeProblem, type DateRange } from "@app/shared/dates";
import { fmtRange, fmtSpan } from "./format";

export const PRESETS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "mtd", label: "Month to date" },
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

/**
 * One "Dates" menu rather than a row of seven buttons: fewer things to read before the numbers.
 * "Pick dates…" shows the two date boxes.
 */
export function DateRangeBar({
  r,
  shown,
}: {
  r: DateRangeState;
  /** What the numbers on the page are for, once they have loaded. */
  shown: { range: DateRange; previous: DateRange; timezone: string } | null;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="date-range" className="text-sm font-medium">Dates</label>
        <select
          id="date-range"
          className="input w-auto cursor-pointer py-1.5 font-medium"
          value={r.preset}
          onChange={(e) => r.choose(e.target.value as PresetId, shown?.range)}
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.id === "custom" ? "Pick dates…" : p.label}</option>
          ))}
        </select>
        {r.preset === "custom" && (
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <input aria-label="From" type="date" min={MIN_CUSTOM_DAY} max={r.today} className="input w-auto py-1.5" value={r.from} onChange={(e) => r.setFrom(e.target.value)} />
            to
            <input aria-label="To" type="date" min={MIN_CUSTOM_DAY} max={r.today} className="input w-auto py-1.5" value={r.to} onChange={(e) => r.setTo(e.target.value)} />
          </span>
        )}
      </div>
      {r.problem && (
        <p className={`text-xs ${r.problem === "incomplete" ? "text-muted" : "text-warn"}`} role="status">{CUSTOM_HINT[r.problem]}</p>
      )}
      {shown && (
        <p className="text-xs text-muted" title={`Days follow the store's time zone (${shown.timezone}).`}>
          Showing {fmtSpan(shown.range.from, shown.range.to)}, compared with {fmtSpan(shown.previous.from, shown.previous.to)}.
        </p>
      )}
    </div>
  );
}
