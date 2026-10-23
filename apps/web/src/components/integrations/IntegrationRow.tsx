"use client";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ArrowRight, Check, Link2, Settings, Zap, type LucideIcon } from "lucide-react";
import type { StateTone } from "@/lib/adConnections";

// ---------------------------------------------------------------------------
// The pieces Settings → Integrations is drawn with (the owner's design, 2026-10-23): the "One Click
// Setup" banner, and a card per platform with its logo tile, name and what it does, the state pill,
// one button (Connect, or Manage once connected) and the chips of what it brings.
// ---------------------------------------------------------------------------

const TONE_COLOR: Record<StateTone, string> = { good: "var(--good)", warn: "var(--warn)", danger: "var(--danger)", neutral: "var(--muted)" };

/**
 * Where a platform stands, as a tinted pill with a dot: the label always says it, the colour backs it
 * up, and the dot pulses while something is under way.
 */
export function RowPill({ label, tone, busy = false, state }: { label: string; tone: StateTone; busy?: boolean; state: string }) {
  return (
    <span className="tone-pill px-3 py-1 text-[0.8125rem] font-medium" style={{ ["--tone" as string]: TONE_COLOR[tone] }} data-testid="platform-state" data-state={state}>
      <span aria-hidden className="relative inline-flex size-2 shrink-0">
        {busy && <span className="animate-ping-soft absolute inset-0 rounded-full bg-[var(--tone)]" />}
        <span className="relative inline-block size-2 rounded-full bg-[var(--tone)]" />
      </span>
      {label}
    </span>
  );
}

/** One platform: its logo, name and what it does, its state and button, then what it brings. */
export function IntegrationRow({
  testid,
  state,
  logo,
  name,
  sub,
  pill,
  action,
  brings,
  children,
}: {
  testid: string;
  /** For tests and styling: the state the pill shows. */
  state: string;
  logo: ReactNode;
  name: string;
  sub: string;
  pill: ReactNode;
  /** The row's button (Connect, Manage, Fix it), if this member may press one. */
  action?: ReactNode;
  /** What connecting it brings, as ticked chips. */
  brings: string[];
  /** What is known about the connection, or why there's nothing to press. */
  children?: ReactNode;
}) {
  return (
    <section
      className="card animate-rise grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-4 rounded-2xl p-5 sm:gap-x-6 sm:p-6"
      aria-labelledby={`${testid}-h`}
      data-testid={testid}
      data-state={state}
    >
      <span className="grid size-14 shrink-0 place-items-center rounded-2xl border border-border bg-white shadow-[var(--shadow)] sm:size-[4.5rem]" aria-hidden>
        {logo}
      </span>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 max-w-xl flex-1 basis-64">
            <h2 id={`${testid}-h`} className="text-lg font-semibold tracking-tight">
              {name}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">{sub}</p>
          </div>
          {/* The pill stays level with the button, whatever the button says under it (WhatsApp's sign-up). */}
          <div className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2">
            <span className="flex h-11 items-center">{pill}</span>
            {action}
          </div>
        </div>
        {children && <div className="space-y-1.5 text-sm">{children}</div>}
        <ul aria-label={`What ${name} brings`} className="flex flex-wrap gap-2 pt-1">
          {brings.map((b) => (
            <li key={b} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg/60 py-1 pl-1.5 pr-2.5 text-xs font-medium">
              <span className="grid size-4 shrink-0 place-items-center rounded-full bg-good text-[var(--surface)]" aria-hidden>
                <Check size={10} strokeWidth={3.4} />
              </span>
              {b}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The class of a row's button: the page's own, a little taller, as in the design. */
const ROW_BUTTON = "h-11 px-5 font-semibold";

/** Connect: a button that opens the platform's sign-in, or a link to the page that does. */
export function ConnectButton({
  name,
  href,
  onClick,
  busy,
  disabled,
  testid,
  icon: Glyph = Link2,
  children,
}: {
  name: string;
  href?: string;
  onClick?: () => void;
  /** What the button says while the browser leaves for the platform ("Opening Google…"). */
  busy?: string | null;
  disabled?: boolean;
  testid?: string;
  icon?: LucideIcon;
  /** Another word than Connect ("Try demo"), which names itself. */
  children?: ReactNode;
}) {
  const inner = (
    <>
      <Glyph size={17} strokeWidth={2.2} aria-hidden />
      {busy ?? children ?? "Connect"}
    </>
  );
  // The page has a Connect button per row: each is named for its platform.
  const label = busy || children ? undefined : `Connect ${name}`;
  return href ? (
    <Link className={`btn-primary ${ROW_BUTTON}`} href={href} aria-label={label} data-testid={testid}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={`btn-primary ${ROW_BUTTON}`} onClick={onClick} disabled={disabled} aria-label={label} data-testid={testid}>
      {inner}
    </button>
  );
}

/** Manage (or "Fix it" when an account is waiting for someone): to where the connection is managed in depth. */
export function ManageLink({ name, href, attention = false }: { name: string; href: string; attention?: boolean }) {
  return (
    <Link className={`${attention ? "btn-primary" : "btn-secondary"} ${ROW_BUTTON}`} href={href} aria-label={`${attention ? "Fix" : "Manage"} ${name}`}>
      <Settings size={17} strokeWidth={2} aria-hidden />
      {attention ? "Fix it" : "Manage"}
    </Link>
  );
}

/** Above the platforms: connecting is one button and the platform's own sign-in; Learn more says how. */
export function OneClickSetup({ adPlatforms }: { adPlatforms: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section
      className="rounded-2xl border p-5 sm:p-6"
      style={{ ["--tone" as string]: "var(--info)", borderColor: "color-mix(in oklab, var(--info) 22%, var(--border))", background: "color-mix(in oklab, var(--info) 7%, var(--surface))" }}
      aria-labelledby={`${id}-h`}
      data-testid="one-click-setup"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface shadow-[var(--shadow)]" aria-hidden>
          <span className="grid size-10 place-items-center rounded-full bg-[var(--tone)] text-[var(--surface)]">
            <Zap size={20} strokeWidth={2.2} fill="currentColor" />
          </span>
        </span>
        <div className="min-w-0 flex-1 basis-60">
          <h2 id={`${id}-h`} className="font-semibold">
            One Click Setup
          </h2>
          <p className="mt-1 text-sm text-muted">Connect your accounts securely. We handle the setup, so you can focus on growing your business.</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-[color-mix(in_oklab,var(--info)_85%,var(--text))] underline-offset-4 hover:underline"
          aria-expanded={open}
          aria-controls={`${id}-how`}
          onClick={() => setOpen((o) => !o)}
        >
          Learn more
          <ArrowRight size={16} strokeWidth={2.2} aria-hidden className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        </button>
      </div>
      {open && (
        <ol id={`${id}-how`} className="mt-4 grid gap-3 border-t border-[color-mix(in_oklab,var(--info)_18%,var(--border))] pt-4 text-sm sm:grid-cols-3">
          {[
            ["Press Connect", "next to the platform you use."],
            ["Sign in on its own page", `${adPlatforms ? "Shopify, Google or Meta" : "Shopify"} asks you to sign in and choose what to share with bizinsights.`],
            [
              "That's it",
              `bizinsights fills in your dashboard and keeps it up to date by itself. There are no keys or codes to copy${adPlatforms ? ", and ad accounts are read-only: bizinsights can't change your ads or spend money" : ""}.`,
            ],
          ].map(([title, text], i) => (
            <li key={title} className="flex items-start gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--tone)] text-xs font-semibold text-[var(--surface)]" aria-hidden>
                {i + 1}
              </span>
              <span>
                <span className="font-semibold">{title}</span> <span className="text-muted">{text}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
