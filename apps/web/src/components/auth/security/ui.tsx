"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Laptop, Monitor, MonitorSmartphone, Smartphone, Tablet, type LucideIcon } from "lucide-react";
import type { DeviceKind } from "@app/shared/device";
import { authErrorMessage, errorCode, type SignInPlace } from "@/lib/auth";

// Pieces the Security page's cards share: tones, icon discs, pills, a device's picture, a place
// with its flag, and the dates.

export type Msg = { kind: "error" | "success" | "info"; text: string } | null;

/** A refusal that asks the person to sign in again is advice, not a failure. */
export const failure = (err: unknown): Msg => ({ kind: errorCode(err) === "reauth_required" ? "info" : "error", text: authErrorMessage(err) });

export const TONES = {
  info: "var(--info)",
  violet: "var(--violet)",
  good: "var(--good)",
  warn: "var(--warn)",
  danger: "var(--danger)",
} as const;
export type Tone = keyof typeof TONES;

/** Style that sets a block's `--tone` (the tone-* utilities in globals.css read it). */
export const tone = (t: Tone): CSSProperties => ({ ["--tone" as string]: TONES[t] });

export function ToneIcon({ icon: Glyph, t, size = "md" }: { icon: LucideIcon; t: Tone; size?: "sm" | "md" | "lg" }) {
  const box = size === "lg" ? "size-14" : size === "md" ? "size-12" : "size-10";
  return (
    <span className={`tone-icon ${box}`} style={tone(t)} aria-hidden>
      <Glyph size={size === "lg" ? 26 : size === "md" ? 22 : 18} strokeWidth={1.9} />
    </span>
  );
}

export function Pill({ t, children, dot = false }: { t: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className="tone-pill" style={tone(t)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/**
 * One of the cards along the top (email, password, two-step verification): its tone's icon disc,
 * the title with its button beside it, and what it says under them.
 */
export function SummaryCard({ id, t, icon, title, action, children }: { id: string; t: Tone; icon: LucideIcon; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="tone-card flex items-start gap-4 rounded-xl border p-5 shadow-[var(--shadow)]" style={tone(t)}>
      <ToneIcon icon={icon} t={t} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h2 id={id} className="pt-1 font-semibold">
            {title}
          </h2>
          {action}
        </div>
        <div className="mt-1.5 space-y-2 text-sm">{children}</div>
      </div>
    </section>
  );
}

/** A plain card of the page (devices, activity, signing out): an icon disc, the title and its line, actions on the right. */
export function CardHeader({ id, t, icon, title, sub, action }: { id: string; t: Tone; icon: LucideIcon; title: string; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3.5">
        <ToneIcon icon={icon} t={t} size="sm" />
        <div className="min-w-0">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {sub && <p className="mt-0.5 text-sm text-muted">{sub}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

const DEVICE_ICONS: Record<DeviceKind, LucideIcon> = { phone: Smartphone, tablet: Tablet, laptop: Laptop, desktop: Monitor, unknown: MonitorSmartphone };

export function DeviceIcon({ kind }: { kind: DeviceKind }) {
  const Glyph = DEVICE_ICONS[kind];
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-bg/60 text-muted" aria-hidden>
      <Glyph size={20} strokeWidth={1.7} />
    </span>
  );
}

let regions: Intl.DisplayNames | null = null;
/** "IN" → "India" (the code itself where the browser has no name for it). */
export function countryName(code: string): string {
  try {
    regions ??= new Intl.DisplayNames(undefined, { type: "region" });
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}

/** The country's flag (public/flags, copied from country-flag-icons at build time); nothing if it doesn't load. */
export function Flag({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !/^[A-Z]{2}$/.test(code)) return null;
  return (
    <img src={`/flags/${code}.svg`} alt="" width={21} height={14} loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-3.5 w-[21px] shrink-0 rounded-[3px] object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.08)]" />
  );
}

/** Where a sign-in came from: the place on one line and the country under it (`compact`: one line). */
export function Place({ place, compact = false }: { place: SignInPlace | null; compact?: boolean }) {
  if (!place) return <span className="text-muted">Unknown</span>;
  const country = place.country ? countryName(place.country) : null;
  const local = [place.city, place.region && place.region !== place.city ? place.region : null].filter(Boolean).join(", ");
  return (
    <span className="flex min-w-0 items-center gap-2.5" title="Approximate, from the address it signed in from">
      {place.country && <Flag code={place.country} />}
      {compact ? (
        <span className="truncate">{[place.city ?? place.region, country].filter(Boolean).join(", ") || "Unknown"}</span>
      ) : (
        <span className="min-w-0 leading-tight">
          <span className="block truncate">{local || country || "Unknown"}</span>
          {local && country && <span className="block truncate text-muted">{country}</span>}
        </span>
      )}
    </span>
  );
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
export const day = (t: string | number | Date) => dateFmt.format(new Date(t));
export const time = (t: string | number | Date) => timeFmt.format(new Date(t));
export const dayTime = (t: string | number | Date) => `${day(t)}, ${time(t)}`;
