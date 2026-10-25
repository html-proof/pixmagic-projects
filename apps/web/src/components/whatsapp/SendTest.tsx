"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { fmtWhen } from "@/components/messaging/MessagingUi";
import type { WaMessage, WaOverview, WaTemplatesAnswer } from "./types";
import { MessageStatus, reasonText, TemplatePreview, useWaAction, waError, waHref } from "./WaUi";

/** Statuses after which nothing more is waited for here (read receipts still show in the history). */
const SETTLED = new Set(["delivered", "read", "failed", "cancelled", "skipped"]);
/** How long the dialog follows the message before pointing to the history instead. */
const FOLLOW_MS = 2 * 60_000;

/**
 * "Send test message": an approved template, with sample values, to the merchant's own test number
 * only, after they press Send. The dialog then follows that message's real status as Meta reports it
 * (accepted is not delivered), and says what went wrong in Meta's words when it fails.
 */
export function SendTestMessage({ base, overview, open, onClose }: { base: string; overview: WaOverview; open: boolean; onClose: () => void }) {
  const templates = useApi<WaTemplatesAnswer>(open ? `${base}/templates` : null);
  const approved = useMemo(() => (templates.data?.templates ?? []).filter((t) => t.status === "APPROVED" && t.category !== "AUTHENTICATION"), [templates.data]);
  const [id, setId] = useState("");
  const [sent, setSent] = useState<{ message: WaMessage; at: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useWaAction();
  const template = approved.find((t) => t.id === id) ?? approved[0] ?? null;
  const testPhone = overview.settings.testPhone;
  const tz = overview.store.timezone;

  // Follow the message: every 3 seconds until it settles, for two minutes at most.
  useEffect(() => {
    if (!sent || SETTLED.has(sent.message.status) || Date.now() - sent.at > FOLLOW_MS) return;
    const t = window.setTimeout(() => {
      api<{ message: WaMessage }>(`${base}/messages/${sent.message.id}`)
        .then((r) => setSent((s) => (s && s.message.id === r.message.id ? { ...s, message: r.message } : s)))
        .catch(() => setSent((s) => (s ? { ...s } : s)));
    }, 3000);
    return () => window.clearTimeout(t);
  }, [base, sent]);

  const close = () => {
    setSent(null);
    setError(null);
    onClose();
  };
  const send = () =>
    run("send", "send the test", async () => {
      setError(null);
      try {
        const r = await api<{ message: WaMessage }>(`${base}/templates/${template!.id}/test`, { method: "POST", body: {} });
        setSent({ message: r.message, at: Date.now() });
      } catch (e) {
        setError(waError(e, "send the test"));
        throw e;
      }
    });

  const m = sent?.message;
  const following = !!m && !SETTLED.has(m.status) && Date.now() - (sent?.at ?? 0) <= FOLLOW_MS;
  return (
    <Dialog open={open} title="Send a test message" onClose={close}>
      <div className="space-y-3" data-testid="wa-send-test">
        {!testPhone ? (
          <Alert kind="info">
            Tests go only to your own WhatsApp number, never to customers.{" "}
            <Link className="underline" href={waHref("settings")} onClick={close}>
              Add your number in Settings
            </Link>{" "}
            first.
          </Alert>
        ) : templates.error ? (
          <Alert>We couldn&apos;t read your templates just now. Close this and try again.</Alert>
        ) : !templates.data ? (
          <p className="text-sm text-muted">Reading your templates…</p>
        ) : !approved.length ? (
          <Alert kind="info">
            A test needs a template Meta approved.{" "}
            <Link className="underline" href={waHref("templates")} onClick={close}>
              Write one
            </Link>
            ; Meta usually reviews it within minutes.
          </Alert>
        ) : (
          <>
            <p className="text-sm">
              To <strong>{testPhone}</strong> (your test number), with sample values.
            </p>
            {!m && (
              <>
                <div>
                  <label className="label" htmlFor="wa-test-template">
                    Template
                  </label>
                  <select id="wa-test-template" className="input" value={template?.id ?? ""} onChange={(e) => setId(e.target.value)}>
                    {approved.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.language})
                      </option>
                    ))}
                  </select>
                </div>
                {template && <TemplatePreview components={template.components} mapping={null} />}
              </>
            )}
            {m && (
              <div className="space-y-2 rounded-lg border border-border p-3" role="status" aria-live="polite">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <MessageStatus m={m} /> {following && <span className="text-muted">Waiting for WhatsApp&apos;s report…</span>}
                </p>
                <ol className="space-y-1 text-xs text-muted">
                  <li>Queued {fmtWhen(m.createdAt, tz)}</li>
                  {m.acceptedAt && <li>Accepted by WhatsApp {fmtWhen(m.acceptedAt, tz)}</li>}
                  {m.sentAt && <li>Sent {fmtWhen(m.sentAt, tz)}</li>}
                  {m.deliveredAt && <li>Delivered to the phone {fmtWhen(m.deliveredAt, tz)}</li>}
                  {m.readAt && <li>Read {fmtWhen(m.readAt, tz)}</li>}
                </ol>
                {m.status === "failed" || m.status === "skipped" || m.status === "cancelled" ? (
                  <Alert>{m.errorTitle ?? reasonText(m.reason) ?? "WhatsApp couldn't send it."}</Alert>
                ) : m.status === "delivered" || m.status === "read" ? (
                  <p className="text-sm text-good">It reached your phone.</p>
                ) : !following ? (
                  <p className="text-sm text-muted">
                    No delivery report yet. &ldquo;Accepted&rdquo; means Meta took it, not that it arrived; follow it in{" "}
                    <Link className="underline" href={waHref("activity")} onClick={close}>
                      Message history
                    </Link>
                    .
                  </p>
                ) : (
                  <p className="text-xs text-muted">&ldquo;Accepted&rdquo; means Meta took it; only &ldquo;Delivered&rdquo; means it reached the phone.</p>
                )}
              </div>
            )}
            {error && <Alert>{error}</Alert>}
          </>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {m && !following && (
            <button type="button" className="btn-secondary" onClick={() => setSent(null)}>
              Send another
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={close}>
            Done
          </button>
          {!m && testPhone && approved.length > 0 && (
            <button type="button" className="btn-primary" disabled={!template || busy === "send"} onClick={() => void send()}>
              {busy === "send" ? "Sending…" : "Send test"}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
