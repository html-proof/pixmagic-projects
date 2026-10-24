"use client";
import Link from "next/link";
import { useState } from "react";
import { ChevronDown, CircleAlert, ExternalLink } from "lucide-react";
import { CHANNEL_INFO, type HubChannel } from "@app/shared/automations";
import { ConfirmDialog, useToast } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { api } from "@/lib/api";
import { ChannelIcon, ConnectionBadge, fmtWhen, hubError, useHub } from "./HubUi";
import type { ChannelConnection, HubPermissions } from "./types";

// ---------------------------------------------------------------------------
// Step 1, and the top of the hub: one card per channel with its real connection state (the
// API's answer, never the page's guess), what stops messages, and the provider's own way in.
// SMS connects here (bizinsights asks AWS with its own role: the merchant gives no keys); email
// connects through the email module's sign-in with Google or Microsoft, or SMTP; WhatsApp lives
// on its own pages.
// ---------------------------------------------------------------------------

const EMAIL_ACCOUNTS = "/settings/email/accounts";

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

  return (
    <div className="space-y-3">
      {problem && <Alert onDismiss={() => setProblem(null)}>{problem}</Alert>}
      <ul className="grid gap-3 lg:grid-cols-3" aria-label="Messaging channels">
        {connections.map((c) => {
          const info = CHANNEL_INFO[c.channel];
          const picked = selected === c.channel;
          const pickable = !!onSelect && c.allowed && c.state !== "elsewhere" && c.state !== "unavailable";
          return (
            <li key={c.channel} className={`card animate-rise flex flex-col gap-3 ${picked ? "border-accent ring-2 ring-accent/30" : ""}`} aria-label={info.label} data-testid={`channel-${c.channel}`}>
              <div className="flex items-start gap-3">
                <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <ChannelIcon channel={c.channel} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {info.label} <ConnectionBadge state={c.state} />
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{info.provider}</p>
                </div>
              </div>
              <p className="text-sm">{c.summary}</p>
              {c.channel === "sms" && c.mode === "sandbox" && (
                <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">Test mode: automatic texts are recorded in the history, not sent. Test texts still reach your verified numbers.</p>
              )}
              {c.accounts.length > 0 && (
                <ul className="space-y-1.5 text-sm" aria-label={`${info.label} accounts`}>
                  {c.accounts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
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
                            className="btn-secondary h-8 px-2.5 text-xs"
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
                          <button type="button" className="btn-secondary h-8 px-2.5 text-xs" disabled={!!busy} onClick={() => setDisconnect({ channel: "email", accountId: a.id, label: a.label })}>
                            Disconnect
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {c.problems.length > 0 && (
                <ul className="space-y-1 text-xs" aria-label={`What stops ${info.label} messages`}>
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
              {c.checkedAt && <p className="text-xs text-muted">Last checked {fmtWhen(c.checkedAt)}</p>}

              <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-3">
                {c.channel === "whatsapp" && c.allowed && (
                  <Link href={info.home} className="btn-secondary inline-flex h-8 items-center gap-1.5 px-3 text-xs">
                    Open WhatsApp <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                  </Link>
                )}
                {c.channel === "sms" &&
                  c.actions.map((op) =>
                    op === "disconnect" ? (
                      <button key={op} type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => setDisconnect({ channel: "sms", label: "SMS" })}>
                        Disconnect
                      </button>
                    ) : (
                      <button key={op} type="button" className={`${op === "test" ? "btn-secondary" : "btn-primary"} h-8 px-3 text-xs`} disabled={!!busy} onClick={() => void smsAction(op === "reconnect" ? "connect" : op)}>
                        {busy === `sms:${op === "reconnect" ? "connect" : op}` ? "Checking…" : op === "connect" ? "Connect SMS" : op === "reconnect" ? "Reconnect" : "Test connection"}
                      </button>
                    ),
                  )}
                {c.channel === "sms" && c.allowed && (
                  <Link href="/messaging/setup" className="inline-flex h-8 items-center px-2 text-xs text-muted hover:text-text">
                    Sender and limits
                  </Link>
                )}
                {c.channel === "email" && c.actions.includes("connect") && (
                  <Link href={`${EMAIL_ACCOUNTS}?add=1`} className={`${c.accounts.length ? "btn-secondary" : "btn-primary"} inline-flex h-8 items-center px-3 text-xs`}>
                    {c.accounts.length ? "Add a mailbox" : "Connect a mailbox"}
                  </Link>
                )}
                {c.channel === "email" && c.actions.includes("reconnect") && (
                  <Link href={EMAIL_ACCOUNTS} className="btn-primary inline-flex h-8 items-center px-3 text-xs">
                    Sign in again
                  </Link>
                )}
                {pickable && (
                  <button type="button" className={`${picked ? "btn-primary" : "btn-secondary"} ml-auto h-8 px-3 text-xs`} aria-pressed={picked} onClick={() => onSelect!(c.channel)}>
                    {picked ? "Chosen" : `Use ${info.label}`}
                  </button>
                )}
              </div>
            </li>
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
      <button type="button" className="inline-flex items-center gap-1 text-muted hover:text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} /> What you need, and what bizinsights can do
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-muted">
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
          <p>Passwords and tokens never reach this page: they stay encrypted on bizinsights' servers.</p>
        </div>
      )}
    </div>
  );
}
