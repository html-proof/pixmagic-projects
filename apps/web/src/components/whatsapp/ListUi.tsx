"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { overlay } from "@/components/AppUi";
import { api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shared pieces of the WhatsApp pages: times, delays and countries as people say them, the country
// picker, a side drawer and paged lists. App-wide pieces (toasts, confirm dialog, page header) are
// in AppUi.
// ---------------------------------------------------------------------------

/** A moment in the store's time zone: "22 Oct, 3:04 pm". */
export function fmtWhen(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** "9 pm" for an hour of the day (quiet hours). */
export const fmtHour = (h: number) => new Intl.DateTimeFormat(undefined, { hour: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 0, 1, h)));

/** Minutes as people say them: "right away", "45 minutes", "2 hours", "3 days". */
export function fmtDelay(minutes: number): string {
  if (!minutes) return "right away";
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

let regionNames: Intl.DisplayNames | null = null;
/** A country's name from its ISO code ("Unknown" without one). */
export function countryName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The countries offered in pickers: the common ones. Any other code can be added. */
export const COUNTRY_CHOICES: string[] = ["AU", "NZ", "US", "CA", "GB", "IN", "IE", "SG", "HK", "MY", "PH", "AE", "ZA", "DE", "FR", "NL"];

// ---------------------------------------------------------------------------
// Countries
// ---------------------------------------------------------------------------

/** Pick countries: the common ones as checkable chips, any other by its two-letter code. */
export function CountryPicker({ label, value, onChange, disabled = false, help }: { label: string; value: string[]; onChange: (next: string[]) => void; disabled?: boolean; help?: ReactNode }) {
  const id = useId();
  const [other, setOther] = useState("");
  const all = [...COUNTRY_CHOICES, ...value.filter((c) => !COUNTRY_CHOICES.includes(c))];
  const toggle = (c: string) => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c]);
  const code = other.trim().toUpperCase();
  const valid = /^[A-Z]{2}$/.test(code);
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <legend className="label">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {all.map((c) => {
          const on = value.includes(c);
          return (
            <label key={c} className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-xs transition ${on ? "bg-accent/10 text-accent" : "bg-home-soft hover:bg-home-soft-hover"}`}>
              <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={on} onChange={() => toggle(c)} />
              {countryName(c)} <span className="text-muted">{c}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2 flex max-w-xs items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-other`}>
          Another country&apos;s two-letter code
        </label>
        <input
          id={`${id}-other`}
          className="input h-8 w-24 py-1 text-xs uppercase"
          maxLength={2}
          placeholder="e.g. JP"
          value={other}
          onChange={(e) => setOther(e.target.value.replace(/[^a-z]/gi, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (valid && !value.includes(code)) onChange([...value, code]);
              setOther("");
            }
          }}
        />
        <button
          type="button"
          className="btn-secondary h-8 px-3 text-xs"
          disabled={!valid || value.includes(code)}
          onClick={() => {
            onChange([...value, code]);
            setOther("");
          }}
        >
          Add country
        </button>
      </div>
      {help && <div className="mt-1 text-xs text-muted">{help}</div>}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// A panel over the page (a message's details, a customer's consent history)
// ---------------------------------------------------------------------------

/** A side panel: Escape or the backdrop closes it, focus returns where it was. */
export function Drawer({ title, sub, onClose, children }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, read when a key is pressed: focus moves only when the panel opens.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog opened from the panel closes first.
      if (e.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]:not([data-drawer])')) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, []);
  return overlay(
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={id} data-drawer>
      <div className="animate-fade absolute inset-0 bg-black/45" onClick={onClose} aria-hidden />
      <div ref={ref} className="animate-sheet relative flex h-full w-full max-w-xl flex-col bg-bg shadow-2xl sm:border-l sm:border-border">
        <header className="flex items-start gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id={id} className="truncate text-lg font-semibold">
              {title}
            </h2>
            {sub && <div className="text-xs text-muted">{sub}</div>}
          </div>
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">{children}</div>
      </div>
    </div>,
  );
}

// ---------------------------------------------------------------------------
// Paged lists ("Load more")
// ---------------------------------------------------------------------------

/**
 * A list the API pages with a cursor (`nextCursor`), loaded again whenever `path` changes (the
 * filters are in it). Only the latest request may fill the list: an older one answering late would
 * show rows for filters that are no longer selected (docs/architecture.md, "Data and state").
 */
export function usePagedList<T>(path: string | null, field: string, debounceMs = 0) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(
    async (after: string | null) => {
      if (!path) return;
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await api<Record<string, unknown>>(`${path}${after ? `${sep}cursor=${encodeURIComponent(after)}` : ""}`);
        if (request !== latest.current) return;
        const page = (r[field] as T[] | undefined) ?? [];
        setRows((prev) => (after && prev ? [...prev, ...page] : page));
        setCursor((r.nextCursor as string | null | undefined) ?? null);
      } catch (e) {
        if (request === latest.current) setError(e);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [path, field],
  );
  useEffect(() => {
    const t = window.setTimeout(() => void load(null), debounceMs);
    return () => window.clearTimeout(t);
  }, [load, debounceMs]);
  return { rows, cursor, loading, error, loadMore: () => void load(cursor), reload: () => load(null) };
}

/** "1 customer" / "3 customers". */
export const plural = (n: number, one: string, many = `${one}s`) => `${new Intl.NumberFormat().format(n)} ${n === 1 ? one : many}`;
