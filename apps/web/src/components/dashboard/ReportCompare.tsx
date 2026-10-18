"use client";
import { fmtPct } from "@/lib/api";

// ---------------------------------------------------------------------------
// The change column of the live ad reports (Google Ads, Meta Ads), for answers that carry the dates
// compared with. A row the comparison doesn't have (it had no activity then, or fell outside the
// top rows) has nothing to compare with: "—", never a rise from 0.
// ---------------------------------------------------------------------------

/** (now − before) ÷ before; null with nothing (or 0) before. */
export const reportChange = (now: number | null | undefined, before: number | null | undefined) =>
  now === null || now === undefined || before === null || before === undefined || before === 0 ? null : (now - before) / Math.abs(before);

/** One change cell: coloured by whether it's good news, or `neutral` for spend (more isn't good or bad by itself). */
export function ReportChange({ value, neutral = false }: { value: number | null; neutral?: boolean }) {
  const td = "px-2 py-2 text-right text-xs tabular-nums";
  if (value === null) return <td className={`${td} text-muted`}>—</td>;
  const tone = neutral || value === 0 ? "text-muted" : value > 0 ? "text-good" : "text-danger";
  return (
    <td className={`${td} ${tone}`}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))}
    </td>
  );
}
