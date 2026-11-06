"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, CircleAlert, Clock, ExternalLink, FlaskConical, Info, Plug } from "lucide-react";
import { CHANNEL_INFO, type HubChannel } from "@app/shared/automations";
import { ConfirmDialog, useToast } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { ChannelIcon, ConnectionBadge, fmtWhen, hubError, useHub } from "./HubUi";
import { ChannelPanel, Fact, FactList } from "./MarketingKit";
import type { ChannelConnection, HubPermissions } from "./types";

// ---------------------------------------------------------------------------
// Step 1, and the foot of the hub: one card per channel with its real connection state (the
// API's answer, never the page's guess), what stops messages, and the provider's own way in, as
// the Stitch design's screen 18 draws a channel: its name, one status word, the one main button,
// then its facts, with the quieter buttons at the foot. SMS connects here (bizinsights asks AWS
// with its own role: the merchant gives no keys); email connects through the email module's
// sign-in with Google or Microsoft, or SMTP; WhatsApp lives on its own pages.
// ---------------------------------------------------------------------------

const EMAIL_ACCOUNTS = "/settings/email/accounts";
const small = "h-8 px-3 text-xs";

export function ChannelCards({
  connections,
  permissions,
  onChanged,
  selected,
  onSelect,
}: {
  connections: ChannelConnection[];
  permissions: HubPermissions;
  onChanged: () => unknown;
  /** Step 1 of the setup: the cards pick the channel. */
  selected?: HubChannel | null;
  onSelect?: (c: HubChannel) => void;
}) {
  const { path } = useHub();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [disconnect, setDisconnect] = useState<{ channel: HubChannel; accountId?: string; label: string } | null>(null);

  const run = async (key: string, what: string, fn: () => Promise<{ connection?: ChannelConnection; ok?: boolean; message?: string | null }>, done: (r: { connection?: ChannelConnection; ok?: boolean; message?: string | null }) => string) => {
    setBusy(key);
    setProblem(null);
    try {
      const r = await fn();
      await onChanged();
      toast(r.ok === false ? "error" : "success", done(r));
      return true;
    } catch (e) {
      setProblem(hubError(e, what));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const smsAction = (op: "connect" | "test" | "disconnect") =>
    run(
      `sms:${op}`,
      op === "disconnect" ? "disconnect SMS" : "check the SMS connection",
      () => api(path(`/connections/sms/${op}`), { method: "POST", body: {} }),
      (r) => (op === "disconnect" ? "SMS disconnected. Texts that were waiting were cancelled." : r.connection?.state === "connected" ? "AWS answered: SMS is connected." : (r.connection?.summary ?? "Checked.")),
    );

  /** An SMS connection action as a button: connecting is the card's main button, testing a quiet one. */
  const smsButton = (op: ChannelConnection["actions"][number], main: boolean) => {
    if (op === "disconnect") {
      return (
        <button key={op} type="button" className={`btn-secondary ${small}`} disabled={!!busy} onClick={() => setDisconnect({ channel: "sms", label: "SMS" })}>
          Disconnect
        </button>
      );
    }
    const key = op === "reconnect" ? "connect" : op;
    return (
      <button key={op} type="button" className={`${op === "test" ? "btn-secondary" : "btn-primary"} ${main ? "" : small}`} disabled={!!busy} onClick={() => void smsAction(key)}>
        {busy === `sms:${key}` ? "Checking…" : op === "connect" ? "Connect SMS" : op === "reconnect" ? "Reconnect" : "Test connection"}
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
      <ul className="grid gap-4 lg:grid-cols-3" aria-label="Messaging channels">
        {connections.map((c) => {
          const info = CHANNEL_INFO[c.channel];
          const picked = selected === c.channel;
          const pickable = !!onSelect && c.allowed && c.state !== "elsewhere" && c.state !== "unavailable";
          // The card's one main button: connect (or sign in again) when it isn't connected, otherwise where it's managed.
          const smsMain = c.channel === "sms" ? c.actions.find((op) => op === "connect" || op === "reconnect") : undefined;
          const main =
            c.channel === "whatsapp" ? (
              c.allowed && (
                <Link href={info.home} className="btn-secondary">
                  Open WhatsApp <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                </Link>
              )
            ) : c.channel === "sms" ? (
              smsMain ? (
                smsButton(smsMain, true)
              ) : (
                c.allowed && (
                  <Link href="/messaging/setup" className="btn-secondary">
                    Sender and limits
                  </Link>
                )
              )
            ) : c.actions.includes("reconnect") ? (
              <Link href={EMAIL_ACCOUNTS} className="btn-primary">
                Sign in again
              </Link>
            ) : c.actions.includes("connect") ? (
              <Link href={`${EMAIL_ACCOUNTS}?add=1`} className={c.accounts.length ? "btn-secondary" : "btn-primary"}>
                {c.accounts.length ? "Add a mailbox" : "Connect a mailbox"}
              </Link>
            ) : null;
          const quiet = [
            ...(c.channel === "sms" ? c.actions.filter((op) => op !== smsMain).map((op) => smsButton(op, false)) : []),
            ...(c.channel === "sms" && smsMain && c.allowed
              ? [
                  <Link key="limits" href="/messaging/setup" className="inline-flex h-8 items-center px-2 text-xs text-muted hover:text-text">
                    Sender and limits
                  </Link>,
                ]
              : []),
            // A mailbox to sign in again is the main button; adding another one is then a quiet one.
            ...(c.channel === "email" && c.actions.includes("reconnect") && c.actions.includes("connect")
              ? [
                  <Link key="add" href={`${EMAIL_ACCOUNTS}?add=1`} className={`btn-secondary ${small}`}>
                    {c.accounts.length ? "Add a mailbox" : "Connect a mailbox"}
                  </Link>,
                ]
              : []),
          ];
          return (
            <ChannelPanel
              key={c.channel}
              as="li"
              level={3}
              id={`channel-card-${c.channel}`}
              testId={`channel-${c.channel}`}
              title={info.label}
              icon={<ChannelIcon channel={c.channel} />}
              status={<ConnectionBadge state={c.state} />}
              action={main || undefined}
              className={picked ? "ring-2 ring-accent" : ""}
              footer={
                quiet.length > 0 || pickable ? (
                  <>
                    {quiet}
                    {pickable && (
                      <button type="button" className={`${picked ? "btn-primary" : "btn-secondary"} ml-auto ${small}`} aria-pressed={picked} onClick={() => onSelect!(c.channel)}>
                        {picked ? "Chosen" : `Use ${info.label}`}
                      </button>
                    )}
                  </>
                ) : undefined
              }
            >
              <p>{c.summary}</p>
              <FactList label={`${info.label}: how it works`}>
                <Fact icon={<Plug />} muted>
                  {info.provider}
                </Fact>
                {c.channel === "sms" && c.mode === "sandbox" && (
                  <Fact icon={<FlaskConical />}>
                    <span className="text-warn">Test mode: automatic texts are recorded in the history, not sent. Test texts still reach your verified numbers.</span>
                  </Fact>
                )}
                {c.checkedAt && (
                  <Fact icon={<Clock />} muted>
                    Last checked {fmtWhen(c.checkedAt)}
                  </Fact>
                )}
              </FactList>
              {c.accounts.length > 0 && (
                <ul className="divide-y divide-home-line rounded bg-home-soft" aria-label={`${info.label} accounts`}>
                  {c.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{a.label}</span>
                        <span className="block text-xs text-muted">
                          {a.detail ? `${a.detail} · ` : ""}
                          {a.statusLabel}
                        </span>
                      </span>
                      {c.channel === "email" && permissions.connect.email && (
                        <span className="flex gap-1.5">
                          <button
                            type="button"
                            className="home-btn h-8 bg-surface px-2.5 text-xs"
                            disabled={!!busy}
                            onClick={() =>
                              void run(
                                `email:test:${a.id}`,
                                "test the mailbox",
                                () => api(path(`/connections/email/${a.id}/test`), { method: "POST", body: {} }),
                                (r) => (r.ok ? `${a.label} can send.` : `${a.label} couldn't send: ${r.message ?? "the provider refused"}.`),
                              )
                            }
                          >
                            {busy === `email:test:${a.id}` ? "Testing…" : "Test"}
                          </button>
                          <button type="button" className="home-btn h-8 bg-surface px-2.5 text-xs" disabled={!!busy} onClick={() => setDisconnect({ channel: "email", accountId: a.id, label: a.label })}>
                            Disconnect
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {c.problems.length > 0 && (
                <ul className="space-y-1.5 text-xs" aria-label={`What stops ${info.label} messages`}>
                  {c.problems.map((p) => (
                    <li key={p.code} className="flex gap-1.5 text-warn">
                      <CircleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        {p.message}{" "}
                        {p.fix && (
                          <Link className="font-medium underline" href={p.fix.href}>
                            {p.fix.label}
                          </Link>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Requirements channel={c.channel} />
            </ChannelPanel>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!disconnect}
        title={`Disconnect ${disconnect?.label ?? ""}?`}
        confirmLabel="Disconnect"
        danger
        busy={busy?.startsWith("disconnect") ?? false}
        onCancel={() => setDisconnect(null)}
        onConfirm={() => {
          const d = disconnect!;
          void (
            d.channel === "sms"
              ? run("disconnect:sms", "disconnect SMS", () => api(path("/connections/sms/disconnect"), { method: "POST", body: {} }), () => "SMS disconnected. Texts that were waiting were cancelled.")
              : run(`disconnect:${d.accountId}`, "disconnect the mailbox", () => api(path(`/connections/email/${d.accountId}/disconnect`), { method: "POST", body: {} }), () => `${d.label} disconnected.`)
          ).then(() => setDisconnect(null));
        }}
      >
        {disconnect?.channel === "sms" ? (
          <p>Texting stops at once and texts still waiting are cancelled. Your sender, messages and history stay for when you reconnect.</p>
        ) : (
          <p>bizinsights deletes its access to {disconnect?.label} (and asks the provider to revoke it where it can). Automations sending from it are switched off and its waiting email is cancelled.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** What a channel needs and what bizinsights may do with it, folded away until asked for. */
function Requirements({ channel }: { channel: HubChannel }) {
  const [open, setOpen] = useState(false);
  const info = CHANNEL_INFO[channel];
  return (
    <div className="text-xs">
      <button type="button" className="inline-flex items-center gap-1 rounded-sm text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} /> What you need, and what bizinsights can do
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded bg-home-soft px-3 py-2.5 text-muted">
          <ul className="list-disc space-y-0.5 pl-4">
            {info.requirements.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="font-medium text-text">bizinsights may:</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {info.permissions.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="flex gap-1.5">
            <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Passwords and tokens never reach this page: they stay encrypted on bizinsights' servers.
          </p>
        </div>
      )}
    </div>
  );
}
