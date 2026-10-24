"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Badge, Empty, Stat } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { fmtWhen, plural } from "@/components/messaging/MessagingUi";
import { ConnectWhatsApp } from "./ConnectWhatsApp";
import type { WaNumber, WaOverview, WaStats } from "./types";
import { CONNECTION_TONE, MessageStatus, sourceLabel, useWaAction, waHref, WhatsappIcon } from "./WaUi";

// ---------------------------------------------------------------------------
// The page's first tab: not connected, how to connect; connected, how the number stands, what
// was sent, what needs the merchant, and the one step Meta's sign-up may have left.
// ---------------------------------------------------------------------------

function Steps() {
  const steps: Array<[string, string]> = [
    ["Sign in with Meta", "Meta's own window opens. Sign in with the Facebook account that manages your business, then choose (or create) your WhatsApp Business account and the phone number customers will see."],
    ["bizinsights sets it up", "bizinsights checks what you shared, registers the number for sending, and starts receiving delivery reports and replies. You never copy a token, key or webhook address."],
    ["Send yourself a test", "Add your own WhatsApp number in Settings, pick an approved message template, and see exactly what customers will receive."],
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-3">
      {steps.map(([title, body], i) => (
        <li key={title} className="rounded-lg border border-border bg-bg p-3">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent text-xs text-white">
              {i + 1}
            </span>
            {title}
          </p>
          <p className="mt-1 text-sm text-muted">{body}</p>
        </li>
      ))}
    </ol>
  );
}

/** Not connected (or disconnected): what WhatsApp Automation does, and the button. */
export function Onboarding({ data, base, onConnected }: { data: WaOverview; base: string; onConnected: () => void }) {
  const { platform, can, legacy, connection } = data;
  return (
    <div className="space-y-4">
      {legacy && (
        <Alert kind="info">
          Your earlier WhatsApp connection{legacy.displayPhoneNumber ? ` (${legacy.displayPhoneNumber})` : ""} was retired when WhatsApp was rebuilt, and it no longer sends anything. Connect again below with
          Meta&apos;s sign-in: it takes a couple of minutes and you don&apos;t need any token or key.
        </Alert>
      )}
      {connection?.status === "disconnected" && (
        <Alert kind="info">
          WhatsApp was disconnected{connection.disconnectedAt ? ` on ${fmtWhen(connection.disconnectedAt, data.store.timezone)}` : ""}. Your message history is kept. Connect again to start sending.
        </Alert>
      )}
      <section className="card animate-rise" aria-labelledby="wa-start-h">
        <div className="flex flex-wrap items-start gap-4">
          <WhatsappIcon size={44} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 id="wa-start-h" className="text-lg font-semibold">
              Connect your WhatsApp Business number
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Send order confirmations, shipping updates, reminders and campaigns from your own WhatsApp Business number, through Meta&apos;s official WhatsApp Business Platform. Customers only
              receive messages they agreed to, and every reply of STOP is respected.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <Steps />
        </div>
        <div className="mt-5">
          {!platform.ready ? (
            <Alert kind="info">
              <strong>Connecting WhatsApp isn&apos;t switched on yet.</strong> bizinsights is finishing its setup with Meta. Everything else on this page is ready for when it is.
              {platform.missing?.length ? <span className="mt-1 block text-xs">Still to set on the server: {platform.missing.join(", ")} (docs/whatsapp.md).</span> : null}
            </Alert>
          ) : can.connect ? (
            <ConnectWhatsApp base={base} platform={platform} onConnected={onConnected} />
          ) : (
            <p className="text-sm text-muted">Ask an owner, an admin or someone with the Manage integrations permission to connect WhatsApp.</p>
          )}
        </div>
        <p className="mt-4 text-xs text-muted">
          You&apos;ll need a Facebook account that can manage your business, and a phone number that can receive a code by text or call (or an existing WhatsApp Business account). Meta charges your
          business directly for the conversations it sends; add a payment method in WhatsApp Manager when Meta asks.
        </p>
      </section>
    </div>
  );
}

/** What Meta's sign-up left for the merchant: choose a number, enter the PIN, or check again. */
export function ConnectionStep({ data, base, reload }: { data: WaOverview; base: string; reload: () => void }) {
  const c = data.connection!;
  const { busy, run } = useWaAction();
  const [pin, setPin] = useState("");
  const [choice, setChoice] = useState("");
  const numbers = useApi<{ numbers: WaNumber[] }>(c.step === "choose_number" && data.can.connect ? `${base}/connect/numbers` : null);
  const check = () => run("check", "check WhatsApp again", async () => {
    await api(`${base}/connect/check`, { method: "POST", body: {} });
    reload();
    return "Checked with WhatsApp.";
  });
  if (!data.can.connect) return <Alert kind="info">{c.statusDetail ?? "WhatsApp needs one more step."} Ask someone with the Manage integrations permission to finish it.</Alert>;
  return (
    <section className="card animate-rise border-warn" aria-labelledby="wa-step-h" data-testid="wa-step">
      <h2 id="wa-step-h" className="font-semibold">
        One more step
      </h2>
      <p className="mt-1 text-sm text-muted">{c.statusDetail}</p>
      {c.step === "choose_number" && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("number", "use that number", async () => {
              await api(`${base}/connect/number`, { method: "POST", body: { phoneNumberId: choice } });
              reload();
              return "Number chosen.";
            });
          }}
        >
          {numbers.error ? (
            <Alert>We couldn&apos;t read your numbers from WhatsApp just now. Press Check again in a minute.</Alert>
          ) : !numbers.data ? (
            <p className="text-sm text-muted">Reading your numbers from WhatsApp…</p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="label">Your WhatsApp numbers</legend>
              {numbers.data.numbers.map((n) => (
                <label key={n.id} className={`flex items-center gap-3 rounded-lg border p-3 text-sm ${n.inUse ? "opacity-60" : "cursor-pointer hover:bg-bg"}`}>
                  <input type="radio" name="wa-number" value={n.id} disabled={n.inUse} checked={choice === n.id} onChange={() => setChoice(n.id)} />
                  <span className="min-w-0">
                    <span className="font-medium">{n.displayPhoneNumber ?? n.id}</span> {n.verifiedName ? <span className="text-muted">· {n.verifiedName}</span> : null}
                    {n.inUse ? <span className="block text-xs text-muted">Already connected to another store in bizinsights.</span> : null}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <button type="submit" className="btn-primary" disabled={!choice || busy === "number"}>
            {busy === "number" ? "Setting it up…" : "Use this number"}
          </button>
        </form>
      )}
      {c.step === "pin_required" && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run("pin", "register the number", async () => {
              await api(`${base}/connect/pin`, { method: "POST", body: { pin } });
              setPin("");
              reload();
              return "Your number is registered and can send messages.";
            });
          }}
        >
          <div>
            <label className="label" htmlFor="wa-pin">
              Two-step verification PIN
            </label>
            <input id="wa-pin" className="input w-40 tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} />
          </div>
          <button type="submit" className="btn-primary" disabled={pin.length !== 6 || busy === "pin"}>
            {busy === "pin" ? "Registering…" : "Register the number"}
          </button>
          <p className="w-full text-xs text-muted">Forgot it? Reset it in WhatsApp Manager → Phone numbers → your number → Two-step verification, then enter the new one here.</p>
        </form>
      )}
      {(c.step === "no_number" || c.step === "business_app_number" || c.step === "register_failed" || !c.step) && (
        <button type="button" className="btn-primary mt-3" onClick={() => void check()} disabled={busy === "check"}>
          {busy === "check" ? "Checking…" : "Check again"}
        </button>
      )}
    </section>
  );
}

function StatTiles({ s, days }: { s: WaStats; days: number }) {
  const any = s.pending + s.sent + s.delivered + s.failed + s.received + s.skipped > 0;
  if (!any) return <Empty>No WhatsApp messages in the last {days} days. Test messages aren&apos;t counted here.</Empty>;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      <Stat label="Sent" value={fmtNum(s.sent + s.delivered)} note="Accepted by WhatsApp" />
      <Stat label="Delivered" value={fmtNum(s.delivered)} tone={s.delivered ? "good" : undefined} note={s.read ? `${fmtNum(s.read)} read (when customers share read receipts)` : "To the customer's phone"} />
      <Stat label="Failed" value={fmtNum(s.failed)} tone={s.failed ? "danger" : undefined} note={s.skipped ? `${fmtNum(s.skipped)} not sent (consent, no number…)` : "Refused or undeliverable"} />
      <Stat label="Waiting" value={fmtNum(s.pending)} note="Queued for their time" />
      <Stat label="Replies received" value={fmtNum(s.received)} note="Messages from customers" />
      <Stat label="Read" value={fmtNum(s.read)} note="Only counted when the customer shares read receipts" />
    </div>
  );
}

function Check({ done, href, children }: { done: boolean; href: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-2">
      <span aria-hidden className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? "bg-good text-white" : "border border-border text-muted"}`}>
        {done ? "✓" : ""}
      </span>
      <span className={`text-sm ${done ? "text-muted" : ""}`}>
        <span className="sr-only">{done ? "Done: " : "To do: "}</span>
        {done ? (
          children
        ) : (
          <Link className="text-accent underline-offset-2 hover:underline" href={href}>
            {children}
          </Link>
        )}
      </span>
    </li>
  );
}

/** Connected: the number, the week, what needs the merchant, and the latest messages. */
export function Overview({ data, base, reload }: { data: WaOverview; base: string; reload: () => void }) {
  const c = data.connection!;
  const [period, setPeriod] = useState<7 | 30>(7);
  const ck = data.checklist;
  const checks: Array<[boolean, string, string]> = [
    [ck.registered, waHref("overview"), "Register your number for sending"],
    [ck.subscribed, waHref("settings"), "Receive delivery reports and replies (press Check again)"],
    [ck.approvedTemplates > 0, waHref("templates"), "Get a message template approved by Meta"],
    [ck.consentChosen, waHref("settings"), "Choose how customers agree to order updates"],
    [ck.testPhone, waHref("settings"), "Add your own number for test messages"],
    [ck.activeWorkflows > 0, waHref("workflows"), "Switch on a workflow"],
  ];
  const todo = checks.filter(([d]) => !d).length;
  return (
    <div className="space-y-4">
      <section className="card animate-rise" aria-labelledby="wa-acct-h">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <WhatsappIcon size={36} className="shrink-0" />
            <div className="min-w-0">
              <h2 id="wa-acct-h" className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                {c.verifiedName ?? "Your WhatsApp number"} <Badge tone={CONNECTION_TONE[c.status] ?? "neutral"}>{c.statusLabel}</Badge>
              </h2>
              <p className="mt-0.5 text-sm text-muted">
                {c.displayPhoneNumber ?? "No number chosen yet"}
                {c.wabaName ? ` · ${c.wabaName}` : ""}
              </p>
            </div>
          </div>
          {(c.status === "reconnect" || c.status === "error") && data.can.connect && data.platform.ready && <ConnectWhatsApp base={base} platform={data.platform} label="Reconnect WhatsApp" onConnected={() => reload()} />}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Quality</dt>
            <dd>{c.qualityLabel ?? "Not rated yet"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">New conversations a day</dt>
            <dd>{c.dailyConversationLimit === null ? "No limit" : fmtNum(c.dailyConversationLimit)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Replies reaching bizinsights</dt>
            <dd>{c.subscribed ? (c.lastWebhookAt ? `Yes · last ${fmtWhen(c.lastWebhookAt, data.store.timezone)}` : "Yes") : "Not yet"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Connected</dt>
            <dd>{fmtWhen(c.connectedAt, data.store.timezone)}</dd>
          </div>
        </dl>
      </section>

      {c.status === "action_required" && <ConnectionStep data={data} base={base} reload={reload} />}
      {data.problems
        .filter((p) => !p.key.startsWith("step:"))
        .map((p) => (
          <Alert key={p.key} kind={p.key.startsWith("failed") || p.key === "consent" ? "info" : "error"}>
            <strong>{p.title}.</strong> {p.detail}
          </Alert>
        ))}

      {todo > 0 && (
        <section className="card animate-rise" aria-labelledby="wa-setup-h">
          <h2 id="wa-setup-h" className="font-semibold">
            Finish setting up <span className="text-sm font-normal text-muted">({checks.length - todo} of {checks.length} done)</span>
          </h2>
          <ol className="mt-1 divide-y divide-border">
            {checks.map(([done, href, text]) => (
              <Check key={text} done={done} href={href}>
                {text}
              </Check>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="wa-stats-h" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="wa-stats-h" className="text-sm font-semibold">
            Last {period} days
          </h2>
          <div className="flex gap-1" role="group" aria-label="Period">
            {([7, 30] as const).map((d) => (
              <button key={d} type="button" className={`rounded-lg px-3 py-1 text-xs ${period === d ? "bg-surface font-semibold shadow-sm" : "text-muted hover:text-text"}`} aria-pressed={period === d} onClick={() => setPeriod(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <StatTiles s={period === 7 ? data.stats.last7Days : data.stats.last30Days} days={period} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card animate-rise" aria-labelledby="wa-glance-h">
          <h2 id="wa-glance-h" className="font-semibold">
            Automation at a glance
          </h2>
          <ul className="mt-2 space-y-2 text-sm">
            <li>
              <Link className="text-accent underline-offset-2 hover:underline" href={waHref("templates")}>
                {plural(data.counts.templates.approved, "approved template")}
              </Link>
              {data.counts.templates.pending ? <span className="text-muted"> · {fmtNum(data.counts.templates.pending)} waiting for Meta</span> : null}
              {data.counts.templates.rejected ? <span className="text-danger"> · {fmtNum(data.counts.templates.rejected)} rejected or paused</span> : null}
            </li>
            <li>
              <Link className="text-accent underline-offset-2 hover:underline" href={waHref("workflows")}>
                {plural(data.counts.workflows.active, "workflow")} on
              </Link>
              <span className="text-muted"> of {fmtNum(data.counts.workflows.total)}</span>
            </li>
            <li>
              <Link className="text-accent underline-offset-2 hover:underline" href={waHref("campaigns")}>
                {plural(data.counts.campaigns.sending + data.counts.campaigns.scheduled, "campaign")} sending or scheduled
              </Link>
            </li>
          </ul>
        </section>
        <section className="card animate-rise" aria-labelledby="wa-recent-h">
          <div className="flex items-center justify-between gap-2">
            <h2 id="wa-recent-h" className="font-semibold">
              Recent activity
            </h2>
            <Link className="text-sm text-accent underline-offset-2 hover:underline" href={waHref("activity")}>
              All messages
            </Link>
          </div>
          {!data.recent.length ? (
            <p className="mt-2 text-sm text-muted">Nothing sent or received yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {data.recent.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{m.direction === "in" ? "Reply" : (m.templateName ?? m.type)}</span> <span className="text-muted">· {m.phone ?? "—"} · {sourceLabel(m.source)}</span>
                    {m.preview ? <span className="block truncate text-xs text-muted">{m.preview}</span> : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-muted">{fmtWhen(m.createdAt, data.store.timezone)}</span>
                    <MessageStatus m={m} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
