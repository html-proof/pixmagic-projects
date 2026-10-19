"use client";
import { useState } from "react";

/** The periods the Inventory pages report on, as the API's date presets (This year as custom dates). */
export const RANGES = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["mtd", "This month"],
  ["lastmonth", "Previous month"],
  ["year", "This year"],
  ["custom", "Custom dates"],
] as const;
export type RangeId = (typeof RANGES)[number][0];

export interface RangeChoice {
  id: RangeId;
  from?: string;
  to?: string;
}

/** Today in the store's time zone, YYYY-MM-DD. */
const storeToday = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** The query string a choice asks the API with; null while custom dates are incomplete. */
export function rangeQuery(r: RangeChoice, timeZone: string): string | null {
  if (r.id === "year") {
    const today = storeToday(timeZone);
    return `preset=custom&from=${today.slice(0, 4)}-01-01&to=${today}`;
  }
  if (r.id === "custom") return r.from && r.to && r.from <= r.to ? `preset=custom&from=${r.from}&to=${r.to}` : null;
  return `preset=${r.id}`;
}

export function RangePicker({ value, onChange, timeZone }: { value: RangeChoice; onChange: (r: RangeChoice) => void; timeZone: string }) {
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? "");
  const today = storeToday(timeZone);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="input w-auto" aria-label="Period" value={value.id} onChange={(e) => onChange({ id: e.target.value as RangeId, from: from || undefined, to: to || undefined })}>
        {RANGES.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {value.id === "custom" && (
        <>
          <input
            type="date"
            className="input w-auto"
            aria-label="From"
            max={to || today}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              onChange({ id: "custom", from: e.target.value, to });
            }}
          />
          <span className="text-muted">to</span>
          <input
            type="date"
            className="input w-auto"
            aria-label="To"
            min={from}
            max={today}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              onChange({ id: "custom", from, to: e.target.value });
            }}
          />
        </>
      )}
    </div>
  );
}
