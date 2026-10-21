import type { ReactNode } from "react";
import { Dot, type Tone } from "@/components/dashboard/Primitives";

/**
 * A card on Settings → Connect your business (and the ad cards on Settings → Advertising): the
 * platform's icon, name and what it brings, its state badge, what is known about the connection,
 * and the buttons this member may press.
 */
export function IntegrationCard({
  icon,
  name,
  sub,
  badge,
  children,
  actions,
  testid,
  state,
}: {
  icon: ReactNode;
  name: string;
  sub: string;
  badge: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  testid: string;
  /** For tests and styling: the state the badge shows. */
  state: string;
}) {
  return (
    <section className="card animate-rise flex min-w-0 flex-col gap-3" aria-labelledby={`${testid}-h`} data-testid={testid} data-state={state}>
      {/* The badge stays beside the name, however long the line under it. */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-white">{icon}</span>
          <div className="min-w-0">
            <h2 id={`${testid}-h`} className="font-semibold">
              {name}
            </h2>
            <p className="text-sm text-muted">{sub}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-right">{badge}</div>
      </div>
      {children && <div className="space-y-3 text-sm">{children}</div>}
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

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
