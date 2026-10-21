"use client";
/** Pieces the Staff settings sections share: the read-only note, a labelled switch, a whole-number check. */
import type { ReactNode } from "react";

export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return <p className="mb-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted">{children}</p>;
}

export const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

export function Toggle({ id, checked, onChange, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" role="switch" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-describedby={`${id}-hint`} />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}
