import type { ReactNode } from "react";
import { Dot, type Tone } from "@/components/dashboard/Primitives";

/** A badge for a state of any card: the label always says it; the dot backs it up, and pulses while something is under way. */
export function StatusBadge({ label, tone, busy = false, testid = "platform-state", state }: { label: string; tone: Tone; busy?: boolean; testid?: string; state?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs font-normal" data-testid={testid} data-state={state}>
      <Dot tone={tone} pulse={busy} />
      {label}
    </span>
  );
}

/** Label and value pairs about a connection. Values wrap: a long one is read in full, never cut off. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
