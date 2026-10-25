"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/AppUi";
import { Badge, Stat, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum } from "@/lib/api";
import { fmtWhen, plural } from "@/components/messaging/MessagingUi";
import type { WaOverview, WaPlatform } from "./types";
import { CONNECTION_TONE, reasonText, useWaAction, waHref } from "./WaUi";

// ---------------------------------------------------------------------------
// How WhatsApp Automation stands, read from what the API stored (never the page's guess): the
// status tiles, the connection's health, the server setup still missing, what Meta will ask the
// merchant, and "Pause all automation".
// ---------------------------------------------------------------------------

export const AUTOMATION_TONE: Record<string, Tone> = { active: "good", idle: "neutral", paused: "warn", needs_attention: "danger", disconnected: "neutral" };

/** Meta's own pages a merchant may be sent to (official, never deep links that change). */
export const META_LINKS = {
  businessSuite: "https://business.facebook.com/",
  whatsappManager: "https://business.facebook.com/wa/manage/home/",
  businessSettings: "https://business.facebook.com/settings",
  businessSupport: "https://business.facebook.com/business-support-home/",
  appDashboard: "https://developers.facebook.com/apps/",
  platformDocs: "https://developers.facebook.com/docs/whatsapp/",
} as const;

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="text-accent underline-offset-2 hover:underline" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens Meta&apos;s site in a new tab)</span>
    </a>
  );
}

/** Four tiles: the connection, automation, the last word from WhatsApp, and what is waiting to go. */
export function StatusStrip({ data }: { data: WaOverview }) {
  const c = data.connection && data.connection.status !== "disconnected" ? data.connection : null;
  const tz = data.store.timezone;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="wa-status">
      <Stat
        label="WhatsApp connection"
        value={c ? c.statusLabel : "Not connected"}
        tone={c ? (CONNECTION_TONE[c.status] ?? "neutral") : "neutral"}
        note={c ? (c.displayPhoneNumber ?? "No number chosen yet") : data.platform.ready ? "Connect your WhatsApp Business number" : "Connecting isn't available yet"}
      />
      <Stat
        label="Automation"
        value={data.automation.label}
        tone={AUTOMATION_TONE[data.automation.state]}
        note={data.automation.state === "paused" && data.automation.pausedAt ? `Since ${fmtWhen(data.automation.pausedAt, tz)}` : `${plural(data.checklist.activeWorkflows, "workflow")} on`}
      />
      <Stat label="Last update from WhatsApp" value={c?.lastWebhookAt ? fmtWhen(c.lastWebhookAt, tz) : "None yet"} note="Delivery reports and customers' replies" />
      <Stat
        label="Waiting to send"
        value={fmtNum(data.queue.waiting)}
        tone={data.queue.held ? "warn" : undefined}
        note={data.queue.held ? `${fmtNum(data.queue.held)} held: ${data.queue.heldReasons.map((r) => reasonText(r.reason)?.toLowerCase() ?? r.reason).join("; ")}` : data.queue.nextDueAt ? `Next ${fmtWhen(data.queue.nextDueAt, tz)}` : "Nothing queued"}
      />
    </div>
  );
}

/** What each server setting is, for the people who set up bizinsights itself (docs/whatsapp.md). */
const SETTING_HELP: Record<string, string> = {
  WHATSAPP_APP_ID: "bizinsights' Meta app id (Meta app dashboard → App settings → Basic).",
  WHATSAPP_CONFIG_ID: "The id of the app's WhatsApp Embedded Signup configuration (Facebook Login for Business → Configurations → login variation WhatsApp Embedded Signup, v4).",
  WHATSAPP_APP_SECRET: "The app's secret (App settings → Basic). Meta signs every webhook with it. A server secret, never in the page.",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "A long random string Meta repeats back when it checks bizinsights' webhook address. A server secret, generated, not chosen.",
  NANGO_SECRET_KEY: "Nango's secret key: Nango keeps each store's WhatsApp access token.",
};

/**
 * Connecting can't start yet: bizinsights' own Meta app isn't fully set up on this server. Said
 * plainly to every merchant (nothing of theirs to fix); what is missing only to who may connect.
 */
export function PlatformNotReady({ platform, canConnect }: { platform: WaPlatform; canConnect: boolean }) {
  return (
    <div className="space-y-3" data-testid="wa-not-available">
      <Alert kind="info">
        <strong>WhatsApp connections aren&apos;t available on bizinsights yet.</strong> bizinsights&apos; own Meta app still needs setting up on its server, so Meta&apos;s sign-up window can&apos;t open. Nothing
        is connected and no message is sent. There is nothing to change in your Meta or Shopify account: this page updates by itself once it&apos;s ready.
      </Alert>
      <button type="button" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] opacity-60" disabled aria-describedby="wa-not-available-why">
        Connect WhatsApp Business
      </button>
      <p id="wa-not-available-why" className="sr-only">
        Not available until bizinsights finishes setting up its Meta app.
      </p>
      {canConnect && !!platform.missing?.length && (
        <details className="rounded-lg border border-border bg-bg p-3 text-sm" open>
          <summary className="cursor-pointer font-medium">For bizinsights&apos; administrators: still to set on the server</summary>
          <ul className="mt-2 space-y-2">
            {platform.missing.map((m) => (
              <li key={m}>
                <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs">{m}</code> <span className="text-muted">{SETTING_HELP[m] ?? ""}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">
            The full checklist (the Meta app, business verification, App Review, where each value goes) is in docs/whatsapp.md, &ldquo;Setting it up&rdquo;. Meta&apos;s side is done in the{" "}
            <External href={META_LINKS.appDashboard}>Meta app dashboard</External>; the WhatsApp Business Platform&apos;s own guide is <External href={META_LINKS.platformDocs}>here</External>.
          </p>
        </details>
      )}
    </div>
  );
}

/** What Meta asks of a business that connects, with its official pages. No promise that it's always one click. */
export function MetaRequirements() {
  return (
    <section className="card animate-rise" aria-labelledby="wa-req-h">
      <h2 id="wa-req-h" className="font-semibold">
        What Meta will ask you for
      </h2>
      <ul className="mt-2 list-disc space-y-2 pl-5 text-sm">
        <li>
          A Facebook account that manages your business in <External href={META_LINKS.businessSuite}>Meta Business Suite</External> (you can create the business portfolio in Meta&apos;s window).
        </li>
        <li>A phone number customers will see that can receive a code by text or call. A number from the WhatsApp Business app can be used too; Meta moves its messages over.</li>
        <li>
          A payment method for the conversations Meta charges you for, added in <External href={META_LINKS.whatsappManager}>WhatsApp Manager</External>.
        </li>
        <li>
          Sometimes more: Meta may review your display name, limit new numbers until they build a record, or ask to verify your business (Business settings → Security Center, in{" "}
          <External href={META_LINKS.businessSettings}>Business settings</External>). Anything outstanding shows on this page after you connect, with what to do.
        </li>
      </ul>
    </section>
  );
}

/**
 * Meta's window stopped before a WhatsApp Business account was made or chosen
 * (`signupMayBeMetaLimit`): Meta's own limits on the business portfolio, which its window doesn't
 * always manage to show, and where the merchant sees and lifts them.
 */
export function MetaLimitHelp({ className = "" }: { className?: string }) {
  return (
    <p className={`text-sm text-muted ${className}`} data-testid="wa-meta-limit">
      Did Meta&apos;s window show an error or go blank? Meta limits some business portfolios: an unverified business can create only a few WhatsApp Business accounts, and a restricted one, or one still
      being verified, none. See what applies to yours in <External href={META_LINKS.businessSupport}>Business Support Home</External>, remove an account you don&apos;t use in{" "}
      <External href={META_LINKS.whatsappManager}>WhatsApp Manager</External>, or verify the business (Security Center, in <External href={META_LINKS.businessSettings}>Business settings</External>).
      Then try again, or pick another portfolio in Meta&apos;s window.
    </p>
  );
}

interface Check {
  key: string;
  label: string;
  ok: boolean | null;
  detail: string;
}

const PERMISSIONS = ["whatsapp_business_management", "whatsapp_business_messaging"];

/** The connection's health, check by check, as Meta last answered (null: not known yet). */
export function healthChecks(data: WaOverview): Check[] {
  const c = data.connection!;
  const tz = data.store.timezone;
  const missing = PERMISSIONS.filter((p) => !c.grantedScopes.includes(p));
  return [
    {
      key: "access",
      label: "bizinsights' access to your WhatsApp",
      ok: c.status !== "reconnect",
      detail: c.status === "reconnect" ? (c.statusDetail ?? "Meta no longer accepts it: reconnect WhatsApp.") : "Meta accepts it.",
    },
    { key: "permissions", label: "Both WhatsApp permissions granted", ok: missing.length === 0, detail: missing.length ? `Missing: ${missing.join(", ")}. Reconnect and leave both ticked.` : "Manage the account, and send messages." },
    { key: "account", label: "Account in good standing", ok: c.status !== "error", detail: c.status === "error" ? (c.statusDetail ?? "Meta restricted the account. Check WhatsApp Manager.") : (c.qualityLabel ? `Quality: ${c.qualityLabel}.` : "No problem reported by Meta.") },
    { key: "registered", label: "Number registered for sending", ok: c.registered, detail: c.registered ? (c.displayPhoneNumber ?? "Registered.") : (c.statusDetail ?? "Not yet: see the step above.") },
    {
      key: "webhooks",
      label: "Replies and delivery reports reach bizinsights",
      ok: c.subscribed,
      detail: c.subscribed ? `Subscribed${c.subscribedAt ? ` ${fmtWhen(c.subscribedAt, tz)}` : ""}${c.lastWebhookAt ? `; last update ${fmtWhen(c.lastWebhookAt, tz)}` : "; no update received yet"}.` : "Not yet: press Check again.",
    },
    { key: "checked", label: "Last checked with Meta", ok: c.lastCheckedAt ? true : null, detail: c.lastCheckedAt ? `${fmtWhen(c.lastCheckedAt, tz)} (bizinsights checks every 6 hours).` : "Not checked yet." },
  ];
}

/** The health list with "Check again" (which also retries a step that failed: webhooks, registration). */
export function HealthChecks({ data, base, reload }: { data: WaOverview; base: string; reload: () => void }) {
  const { busy, run } = useWaAction();
  const checks = healthChecks(data);
  return (
    <section className="card animate-rise" aria-labelledby="wa-health-h" data-testid="wa-health">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="wa-health-h" className="font-semibold">
          Connection health
        </h2>
        {data.can.connect && (
          <button
            type="button"
            className="btn-secondary h-8 px-3 text-xs"
            disabled={busy === "check"}
            onClick={() =>
              void run("check", "check WhatsApp again", async () => {
                await api(`${base}/connect/check`, { method: "POST", body: {} });
                reload();
                return "Checked with WhatsApp: the number, webhooks and templates are up to date.";
              })
            }
          >
            {busy === "check" ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
      <ul className="mt-2 divide-y divide-border">
        {checks.map((ch) => (
          <li key={ch.key} className="flex items-start gap-3 py-2 text-sm">
            <span aria-hidden className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs ${ch.ok ? "bg-good text-white" : ch.ok === false ? "bg-danger text-white" : "border border-border text-muted"}`}>
              {ch.ok ? "✓" : ch.ok === false ? "!" : "?"}
            </span>
            <span className="min-w-0">
              <span className="sr-only">{ch.ok ? "OK: " : ch.ok === false ? "Problem: " : "Unknown: "}</span>
              <span className="font-medium">{ch.label}</span>
              <span className="block text-xs text-muted">{ch.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Meta's app webhook as bizinsights last found it (for who may connect, once connecting is on). */
export function PlatformWebhook({ data }: { data: WaOverview }) {
  const w = data.platform.webhook;
  if (!data.can.connect || !data.platform.ready || w === undefined) return null;
  const tz = data.store.timezone;
  if (!w) return <p className="text-xs text-muted">bizinsights hasn&apos;t checked its Meta app&apos;s webhook yet; it does within 15 minutes of being set up.</p>;
  if (w.outcome === "set" || w.outcome === "already") return <p className="text-xs text-muted">bizinsights&apos; Meta app sends its webhooks here (Meta confirmed {fmtWhen(w.at, tz)}).</p>;
  return (
    <Alert kind="info">
      {w.outcome === "in_use"
        ? `bizinsights' Meta app sends its WhatsApp webhooks somewhere else (checked ${fmtWhen(w.at, tz)}), so delivery reports and replies don't arrive here. Point it at ${data.webhookUrl} in the Meta app dashboard (WhatsApp → Configuration), with the verify token.`
        : `Meta refused when bizinsights set its app's webhook (${fmtWhen(w.at, tz)}${w.detail ? `: ${w.detail}` : ""}). It tries again every 6 hours.`}
    </Alert>
  );
}

/** Where automation stands, and "Pause all automation" / "Resume" for owners and admins (`manageLink`: also "Manage automation"). */
export function AutomationControl({ data, base, reload, manageLink = true }: { data: WaOverview; base: string; reload: () => void; manageLink?: boolean }) {
  const { busy, run } = useWaAction();
  const [pausing, setPausing] = useState(false);
  const a = data.automation;
  const tz = data.store.timezone;
  const explain: Record<string, string> = {
    active: `${plural(data.checklist.activeWorkflows, "workflow")} on. Each message is checked for the customer's consent right before it goes.`,
    idle: "Connected, but no workflow is switched on yet.",
    paused: `Paused${a.pausedAt ? ` since ${fmtWhen(a.pausedAt, tz)}` : ""}. Workflows start nothing and campaigns wait; messages already waiting are held for up to 48 hours, then cancelled.`,
    needs_attention: "Something stops messages from going: see below.",
    disconnected: "Connect WhatsApp to run automations.",
  };
  const connected = !!data.connection && data.connection.status !== "disconnected";
  return (
    <section className="card animate-rise" aria-labelledby="wa-auto-h" data-testid="wa-automation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="wa-auto-h" className="flex flex-wrap items-center gap-2 font-semibold">
            Automation <Badge tone={AUTOMATION_TONE[a.state] ?? "neutral"}>{a.label}</Badge>
          </h2>
          <p className="mt-1 text-sm text-muted">{explain[a.state]}</p>
          {a.blocked.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {a.blocked.map((b) => (
                <li key={b.id}>
                  <Link className="text-accent underline-offset-2 hover:underline" href={waHref("workflows", { workflow: b.id })}>
                    {b.name}
                  </Link>
                  : {b.problem}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {manageLink && (
            <Link className="btn-primary" href={waHref("workflows")}>
              Manage automation
            </Link>
          )}
          {data.can.manage && connected && a.state !== "paused" && (
            <button type="button" className="btn-secondary" onClick={() => setPausing(true)}>
              Pause all automation
            </button>
          )}
          {data.can.manage && a.state === "paused" && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy === "resume"}
              onClick={() =>
                void run("resume", "resume automation", async () => {
                  const r = await api<{ released: number; campaigns: number }>(`${base}/automation/resume`, { method: "POST", body: {} });
                  reload();
                  return `Automation is running again.${r.released ? ` ${plural(r.released, "held message")} on ${r.released === 1 ? "its" : "their"} way.` : ""}`;
                })
              }
            >
              {busy === "resume" ? "Resuming…" : "Resume automation"}
            </button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={pausing}
        title="Pause all WhatsApp automation?"
        confirmLabel="Pause automation"
        busy={busy === "pause"}
        onCancel={() => setPausing(false)}
        onConfirm={() =>
          void run("pause", "pause automation", async () => {
            await api(`${base}/automation/pause`, { method: "POST", body: {} });
            setPausing(false);
            reload();
            return "All automation is paused. Nothing is sent by workflows or campaigns until you resume.";
          })
        }
      >
        <p>While paused, workflows start nothing (each time a trigger fires is recorded, so you can see what was missed), campaigns don&apos;t start or carry on, and messages already waiting are held.</p>
        <p>Resume within 48 hours and what was held goes out; after that it&apos;s cancelled rather than sent late. Test messages and messages you send yourself still go.</p>
      </ConfirmDialog>
    </section>
  );
}
