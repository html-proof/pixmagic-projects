import type { ReactNode } from "react";
import { fmtPct } from "@/lib/api";

/** A titled dashboard card. `aside` sits top-right (a headline number or a link). */
export function Panel({
  id,
  title,
  help,
  aside,
  className = "",
  children,
}: {
  id: string;
  title: string;
  help?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={`card min-w-0 animate-rise scroll-mt-28 ${className}`} aria-labelledby={`${id}-h`} data-testid={`module-${id}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="font-semibold">{title}</h2>
          {help && <p className="mt-0.5 text-xs text-muted">{help}</p>}
        </div>
        {aside && <div className="text-sm">{aside}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A compact figure inside a card: label, value, one line of plain-language context. */
export function Stat({ label, value, note, tone, className = "" }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone; className?: string }) {
  return (
    <div className={`lift min-w-0 rounded-lg border border-border bg-surface p-3 ${className}`}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 flex items-center gap-2 text-xl font-semibold">
        {tone && <Dot tone={tone} />}
        <span className="truncate">{value}</span>
      </p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </div>
  );
}

/** Quiet text shown when a card has nothing to plot yet. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">{children}</p>;
}

export type Tone = "good" | "warn" | "danger" | "neutral";

const DOT: Record<Tone, string> = { good: "bg-good", warn: "bg-warn", danger: "bg-danger", neutral: "bg-muted" };

export function Dot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  if (!pulse) return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT[tone]}`} />;
  // A soft ring that keeps spreading out from the dot: "this is live".
  return (
    <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0">
      <span className={`animate-ping-soft absolute inset-0 rounded-full ${DOT[tone]}`} />
      <span className={`relative inline-block h-2 w-2 rounded-full ${DOT[tone]}`} />
    </span>
  );
}

/** Status pill: the label always carries the meaning, the dot only reinforces it. */
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs">
      <Dot tone={tone} />
      {children}
    </span>
  );
}

/** Change against the previous period, coloured by whether it's good news (`invert` for costs). */
/** A change with no good or bad direction (spending more isn't good or bad by itself). */
export function NeutralDelta({ value, label = "vs before" }: { value: number | null; label?: string }) {
  if (value === null) return <span className="text-xs text-muted">nothing to compare with</span>;
  return (
    <span className="inline-flex w-fit items-center gap-1 rounded-full bg-border/60 px-2 py-0.5 text-xs text-muted">
      {value > 0 ? "▲" : value < 0 ? "▼" : "■"} {fmtPct(Math.abs(value))} <span className="opacity-80">{label}</span>
    </span>
  );
}

export function Delta({ value, invert = false, label = "vs before" }: { value: number | null | undefined; invert?: boolean; label?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted">no earlier data to compare</span>;
  const good = invert ? value < 0 : value > 0;
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "■";
  const tone = value === 0 ? "bg-border/60 text-muted" : good ? "bg-good/12 text-good" : "bg-danger/12 text-danger";
  return (
    <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {arrow} {fmtPct(Math.abs(value))} <span className="font-normal opacity-80">{label}</span>
    </span>
  );
}

/** What a chart shows, picked from a short list (the sales charts: Custom sales, net sales...). */
export function ChartChoice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <select aria-label={label} className="input h-9 w-auto cursor-pointer py-1 pr-8 text-xs font-medium shadow-[var(--shadow)]" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>{l}</option>
      ))}
    </select>
  );
}
