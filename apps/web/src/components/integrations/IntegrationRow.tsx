"use client";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ArrowRight, Check, Link2, Zap, type LucideIcon } from "lucide-react";
import type { IntegrationStatus } from "@app/shared/integrations";
import type { StateTone } from "@/lib/adConnections";

// ---------------------------------------------------------------------------
// The pieces Settings → Integrations is drawn with, as the owner's approved Stitch design draws its
// Connections screen (prototype v2, screen 30): the "One Click Setup" line, then one white card per
// connection with its small logo tile, name and state at the top, what it does and how it stands
// under them, and its one button (Connect, or Manage once connected) at the foot, beside the chips of
// what it brings.
// ---------------------------------------------------------------------------

/** "info": Meta seen in Shopify, with nothing authorized for bizinsights (MetaDiscovery.tsx): known, and not a connection. */
const TONE_COLOR: Record<StateTone | "info", string> = { good: "var(--good)", warn: "var(--warn)", danger: "var(--danger)", neutral: "var(--muted)", info: "var(--info)" };

/**
 * How each status of the one scale every connection is told on (@app/shared/integrations) is
 * coloured: green when it works, amber while a step is left, red when someone must act, grey
 * otherwise. The cards whose own states are finer (the ad platforms, Shopify, WhatsApp, Zapier) keep
 * their own colours, which a demo's orange needs; SMS and email are told on this scale alone.
 */
export const STATUS_TONE: Record<IntegrationStatus, StateTone> = {
  connected: "good",
  pending: "warn",
  reauthorization_required: "danger",
  syncing: "neutral",
  error: "danger",
  disconnected: "neutral",
};

/**
 * Where a connection stands, as the design's quiet label: a dot and the words in the state's colour.
 * The label always says it, the colour backs it up, and the dot pulses while something is under way.
 */
export function RowPill({ label, tone, busy = false, state }: { label: string; tone: StateTone | "info"; busy?: boolean; state: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-[color-mix(in_oklab,var(--tone)_82%,var(--text))]"
      style={{ ["--tone" as string]: TONE_COLOR[tone] }}
      data-testid="platform-state"
      data-state={state}
    >
      <span aria-hidden className="relative inline-flex size-1.5 shrink-0">
        {busy && <span className="animate-ping-soft absolute inset-0 rounded-full bg-[var(--tone)]" />}
        <span className="relative inline-block size-1.5 rounded-full bg-[var(--tone)]" />
      </span>
      {label}
    </span>
  );
}

/** One connection: its logo, name and state; what it does and how it stands; what it brings and its button. */
export function IntegrationRow({
  testid,
  state,
  status,
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
  /** The same state on the one scale of six every page is told (`data-status`). */
  status?: IntegrationStatus;
  logo: ReactNode;
  name: string;
  sub: string;
  pill: ReactNode;
  /** The card's button (Connect, Manage, Fix it), if this member may press one. */
  action?: ReactNode;
  /** What connecting it brings, as ticked chips. */
  brings: string[];
  /** What is known about the connection, or why there's nothing to press. */
  children?: ReactNode;
}) {
  return (
    <section className="home-card animate-rise flex min-w-0 flex-col p-4 sm:p-5" aria-labelledby={`${testid}-h`} data-testid={testid} data-state={state} data-status={status}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* The logo on the design's small soft tile: never green, so Shopify's bag keeps its own colours. */}
          <span className="grid size-9 shrink-0 place-items-center rounded bg-home-soft" aria-hidden>
            {logo}
          </span>
          <h2 id={`${testid}-h`} className="home-h2 min-w-0 break-words">
            {name}
          </h2>
        </div>
        <span className="flex h-9 shrink-0 items-center">{pill}</span>
      </div>
      <p className="mt-2 text-[13px] leading-[18px] text-muted">{sub}</p>
      {children && <div className="mt-2 min-w-0 space-y-1.5 text-[13px] leading-[18px] break-words">{children}</div>}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-4">
        <ul aria-label={`What ${name} brings`} className="flex min-w-0 flex-1 basis-48 flex-wrap gap-1.5">
          {brings.map((b) => (
            <li key={b} className="inline-flex items-center gap-1 rounded bg-home-soft px-2 py-0.5 text-[11px] font-medium">
              <Check aria-hidden size={11} strokeWidth={3} className="shrink-0 text-accent" />
              {b}
            </li>
          ))}
        </ul>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
    </section>
  );
}

/** The class of a card's button: the design's small one. */
const ROW_BUTTON = "h-9 px-3.5 text-[13px] font-semibold";

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
      <Glyph size={15} strokeWidth={2.2} aria-hidden />
      {busy ?? children ?? "Connect"}
    </>
  );
  // The page has a Connect button per card: each is named for its platform.
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
  return attention ? (
    <Link className={`btn-primary ${ROW_BUTTON}`} href={href} aria-label={`Fix ${name}`}>
      Fix it
    </Link>
  ) : (
    <Link className="home-btn px-3.5 font-semibold" href={href} aria-label={`Manage ${name}`}>
      Manage
    </Link>
  );
}

/** Above the connections: connecting is one button and the platform's own sign-in; Learn more says how. */
export function OneClickSetup({ adPlatforms }: { adPlatforms: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className="home-card animate-rise bg-home-soft px-4 py-3 sm:px-5" aria-labelledby={`${id}-h`} data-testid="one-click-setup">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent text-accent-ink">
          <Zap size={16} strokeWidth={2.2} />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={`${id}-h`} className="text-sm font-semibold">
            One Click Setup
          </h2>
          <p className="text-[13px] leading-[18px] text-muted">Connect your accounts securely. We handle the setup, so you can focus on growing your business.</p>
        </div>
        <button type="button" className="home-btn bg-surface" aria-expanded={open} aria-controls={`${id}-how`} onClick={() => setOpen((o) => !o)}>
          Learn more
          <ArrowRight size={14} strokeWidth={2.2} aria-hidden className={`transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`} />
        </button>
      </div>
      {open && (
        <ol id={`${id}-how`} className="mt-3 grid gap-3 border-t border-home-line pt-3 text-[13px] leading-[18px] sm:grid-cols-3">
          {[
            ["Press Connect", "next to the platform you use."],
            ["Sign in on its own page", `${adPlatforms ? "Shopify, Google or Meta" : "Shopify"} asks you to sign in and choose what to share with bizinsights.`],
            [
              "That's it",
              `bizinsights fills in your dashboard and keeps it up to date by itself. There are no keys or codes to copy${adPlatforms ? ", and ad accounts are read-only: bizinsights can't change your ads or spend money" : ""}.`,
            ],
          ].map(([title, text], i) => (
            <li key={title} className="flex items-start gap-2.5">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-semibold text-accent-ink" aria-hidden>
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
