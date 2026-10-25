"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Paperclip, Send } from "lucide-react";
import { WA_ATTACHMENT_MAX_BYTES, WA_ATTACHMENT_TYPES, WA_SEND_REASONS, WA_SEND_REASON_INFO, WA_TEXT_MAX, type WaSendReason } from "@app/shared/whatsapp";
import { Dialog, Skeleton } from "@/components/AppUi";
import { Drawer, plural, usePagedList } from "@/components/messaging/MessagingUi";
import { Alert, EmptyState } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { api, useApi } from "@/lib/api";
import { LiveStatus } from "./Setup";
import type { WaMessage, WaMessageEvent, WaOverview, WaTemplatesResponse } from "./types";
import { fmtAgo, MessageStatus, newIdempotencyKey, SOURCE_LABEL, useWaAction, WaBubble, waHref } from "./WaUi";

// Message history (searchable, filtered, paged), each message's delivery reports, Retry, and the
// composer. Customers' texts show only to people who may see contact information.

const STATUS_FILTERS: Array<[string, string]> = [
  ["", "Any status"],
  ["waiting", "Waiting"],
  ["sent", "Sent (no report yet)"],
  ["delivered", "Delivered"],
  ["read", "Read"],
  ["failed", "Failed"],
  ["not_sent", "Not sent"],
  ["received", "Received"],
];

export function Messages({ base, overview }: { base: string; overview: WaOverview }) {
  const id = useId();
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState(params.get("status") ?? "");
  const [direction, setDirection] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneQuery, setPhoneQuery] = useState("");
  const campaignId = params.get("campaign") ?? "";
  const automationId = params.get("automation") ?? "";
  const [open, setOpen] = useState<string | null>(null);
  const [compose, setCompose] = useState(params.get("compose") === "1");
  const path = useMemo(() => {
    const q = new URLSearchParams();
    if (status) q.set("status", status);
    if (direction) q.set("direction", direction);
    if (source) q.set("source", source);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (phoneQuery) q.set("phone", phoneQuery);
    if (campaignId) q.set("campaignId", campaignId);
    if (automationId) q.set("automationId", automationId);
    const s = q.toString();
    return `${base}/messages${s ? `?${s}` : ""}`;
  }, [base, status, direction, source, from, to, phoneQuery, campaignId, automationId]);
  const list = usePagedList<WaMessage>(path, "messages");
  const canSend = overview.can.manage && overview.connection?.status === "connected";

  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Message history</h2>
            <p className="text-sm text-muted">Every message sent and received, with WhatsApp&apos;s reports as they arrive.</p>
          </div>
          {(campaignId || automationId) && (
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => router.replace(waHref("messages"))}>
              Showing one {campaignId ? "campaign" : "automation"}'s messages · Show all
            </button>
          )}
          {overview.can.manage && (
            <button type="button" className="btn-primary" onClick={() => setCompose(true)} disabled={!canSend} title={canSend ? undefined : "Connect WhatsApp first"}>
              <Send size={16} aria-hidden /> Send a message
            </button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Select id={`${id}-status`} label="Status" value={status} onChange={setStatus} options={STATUS_FILTERS} />
          <Select id={`${id}-dir`} label="Direction" value={direction} onChange={setDirection} options={[["", "Both"], ["out", "Sent by the store"], ["in", "From customers"]]} />
          <Select id={`${id}-src`} label="Source" value={source} onChange={setSource} options={[["", "Any"], ...Object.entries(SOURCE_LABEL)]} />
          <div>
            <label className="label" htmlFor={`${id}-from`}>
              From
            </label>
            <input id={`${id}-from`} type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-to`}>
              To
            </label>
            <input id={`${id}-to`} type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          {overview.can.contacts && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setPhoneQuery(phone.trim());
              }}
            >
              <label className="label" htmlFor={`${id}-phone`}>
                Number
              </label>
              <input id={`${id}-phone`} className="input" type="search" inputMode="tel" placeholder="+61412345678" value={phone} onChange={(e) => (e.target.value ? setPhone(e.target.value) : (setPhone(""), setPhoneQuery("")))} />
            </form>
          )}
        </div>
      </div>

      {list.error ? (
        <LoadError what="the message history" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.rows ? (
        <Skeleton lines={5} />
      ) : list.rows.length === 0 ? (
        <EmptyState title="No messages" body={status || direction || source || from || to || phoneQuery ? "Nothing matches these filters." : "Messages appear here as soon as one is sent or received."} />
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-border text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Message</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((m) => (
                <tr key={m.id} className="cursor-pointer border-b border-border/60 hover:bg-bg" onClick={() => setOpen(m.id)}>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{fmtAgo(m.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {m.direction === "in" ? "← " : "→ "}
                    {m.phone ?? "–"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-muted">{SOURCE_LABEL[m.source] ?? m.source}</td>
                  <td className="max-w-xs truncate px-4 py-2">
                    <button type="button" className="max-w-full truncate text-left hover:underline" onClick={() => setOpen(m.id)}>
                      {m.preview ?? (overview.can.contacts ? <span className="text-muted">(text no longer kept)</span> : <span className="text-muted">Open for details</span>)}
                    </button>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    <MessageStatus m={m} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.cursor && (
            <div className="p-3 text-center">
              <button type="button" className="btn-secondary" onClick={list.loadMore} disabled={list.loading}>
                {list.loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </div>
      )}

      {open && <MessageDrawer base={base} id={open} overview={overview} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />}
      {compose && (
        <Composer
          base={base}
          overview={overview}
          onClose={() => {
            setCompose(false);
            if (params.get("compose")) router.replace(waHref("messages"));
          }}
          onSent={() => void list.reload()}
        />
      )}
    </div>
  );
}

function Select({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

function MessageDrawer({ base, id, overview, onClose, onChanged }: { base: string; id: string; overview: WaOverview; onClose: () => void; onChanged: () => void }) {
  const r = useApi<{ message: WaMessage; events: WaMessageEvent[] }>(`${base}/messages/${id}`);
  const { busy, run } = useWaAction();
  const m = r.data?.message;
  return (
    <Drawer title={m ? (m.direction === "in" ? `From ${m.phone ?? "a customer"}` : `To ${m.phone ?? "–"}`) : "Message"} sub={m ? `${SOURCE_LABEL[m.source] ?? m.source} · ${new Date(m.createdAt).toLocaleString()}` : undefined} onClose={onClose}>
      {r.error ? (
        <LoadError what="the message" error={r.error} onRetry={() => void r.reload()} busy={r.loading} />
      ) : !m ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <MessageStatus m={m} />
            {m.category && <span className="text-xs text-muted">{m.category === "marketing" ? "Marketing" : "Order or service update"}</span>}
          </div>
          {m.preview ? <WaBubble mine={m.direction === "out"}>{m.preview}</WaBubble> : <p className="text-sm text-muted">{overview.can.contacts ? "The text is no longer kept (the store's retention)." : "You don't have permission to see what was said."}</p>}
          {m.reasonLabel && <Alert kind={m.status === "failed" ? "error" : "info"}>{m.reasonLabel}</Alert>}
          {m.errorDetail && <p className="text-sm text-danger">{m.errorDetail}</p>}
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted">Created</dt>
            <dd>{new Date(m.createdAt).toLocaleString()}</dd>
            {m.status === "queued" && (
              <>
                <dt className="text-muted">Sends at</dt>
                <dd>{new Date(m.sendAfter).toLocaleString()}</dd>
              </>
            )}
            <dt className="text-muted">Accepted by WhatsApp</dt>
            <dd>{m.acceptedAt ? new Date(m.acceptedAt).toLocaleString() : "–"}</dd>
            <dt className="text-muted">Sent</dt>
            <dd>{m.sentAt ? new Date(m.sentAt).toLocaleString() : "–"}</dd>
            <dt className="text-muted">Delivered</dt>
            <dd>{m.deliveredAt ? new Date(m.deliveredAt).toLocaleString() : "–"}</dd>
            <dt className="text-muted">Read</dt>
            <dd>{m.readAt ? new Date(m.readAt).toLocaleString() : "–"}</dd>
            <dt className="text-muted">Tries</dt>
            <dd>{m.attempts}</dd>
            {m.providerMessageId && (
              <>
                <dt className="text-muted">WhatsApp&apos;s id</dt>
                <dd className="break-all font-mono text-xs">{m.providerMessageId}</dd>
              </>
            )}
          </dl>
          <div>
            <h3 className="text-sm font-semibold">Reports from WhatsApp</h3>
            {r.data!.events.length === 0 ? (
              <p className="text-sm text-muted">None yet.</p>
            ) : (
              <ol className="mt-1 space-y-1 text-sm">
                {r.data!.events.map((e) => (
                  <li key={`${e.status}-${e.at}`}>
                    <span className="font-medium">{e.status}</span> {e.providerStatus && <span className="text-xs text-muted">({e.providerStatus})</span>} · {new Date(e.at).toLocaleString()}
                  </li>
                ))}
              </ol>
            )}
          </div>
          {m.canRetry && overview.can.manage && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy === "retry"}
              onClick={() =>
                void run("retry", "send the message again", async () => {
                  await api(`${base}/messages/${m.id}/retry`, { method: "POST", body: {} });
                  await r.reload();
                  onChanged();
                  return "Queued to send again.";
                })
              }
            >
              {busy === "retry" ? "Queuing…" : "Send again"}
            </button>
          )}
        </>
      )}
    </Drawer>
  );
}

/** The file as base64 (without the data: prefix). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("The file couldn't be read."));
    r.readAsDataURL(file);
  });
}

function Composer({ base, overview, onClose, onSent }: { base: string; overview: WaOverview; onClose: () => void; onSent: () => void }) {
  const id = useId();
  const templates = useApi<WaTemplatesResponse>(`${base}/templates`);
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [reason, setReason] = useState<WaSendReason>("order_update");
  const [templateId, setTemplateId] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const [sent, setSent] = useState<string | null>(null);
  const category = WA_SEND_REASON_INFO[reason].category;
  const usable = (templates.data?.templates ?? []).filter((t) => t.usable && t.category === category);
  const chosen = usable.find((t) => t.id === templateId) ?? null;
  useEffect(() => setTemplateId(""), [reason]);

  const ready = phone.trim().length >= 6 && (text.trim() || chosen || file) && !fileError;
  const send = () =>
    run("send", "send the message", async () => {
      const attachment = file ? { name: file.name, mime: file.type, data: await readAsBase64(file) } : null;
      const r = await api<{ message: WaMessage }>(`${base}/messages`, {
        method: "POST",
        body: { phone, country: country || null, reason, text: chosen ? "" : text, templateId: chosen?.id ?? null, attachment, customerAsked: asked, idempotencyKey: key },
      });
      setSent(r.message.id);
      setKey(newIdempotencyKey());
      onSent();
      return "Queued: it goes out within moments.";
    });

  return (
    <Dialog open title="Send a WhatsApp message" onClose={onClose}>
      {sent ? (
        <div className="space-y-3">
          <LiveStatus base={base} messageId={sent} />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setSent(null);
                setText("");
                setFile(null);
              }}
            >
              Send another
            </button>
            <button type="button" className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void send();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
            <div>
              <label className="label" htmlFor={`${id}-to`}>
                To (WhatsApp number)
              </label>
              <input id={`${id}-to`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor={`${id}-cc`}>
                Country
              </label>
              <input id={`${id}-cc`} className="input uppercase" maxLength={2} placeholder="AU" value={country} onChange={(e) => setCountry(e.target.value.replace(/[^a-z]/gi, "").toUpperCase())} />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted">With its country code, or pick the country for a local number.</p>
          <div>
            <label className="label" htmlFor={`${id}-why`}>
              Why you&apos;re messaging
            </label>
            <select id={`${id}-why`} className="input" value={reason} onChange={(e) => setReason(e.target.value as WaSendReason)}>
              {WA_SEND_REASONS.map((r) => (
                <option key={r} value={r}>
                  {WA_SEND_REASON_INFO[r].label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-tpl`}>
              Template (optional)
            </label>
            <select id={`${id}-tpl`} className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Write my own</option>
              {usable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          {chosen ? (
            <WaBubble>{chosen.body}</WaBubble>
          ) : (
            <div>
              <label className="label" htmlFor={`${id}-text`}>
                Message
              </label>
              <textarea id={`${id}-text`} className="input min-h-28" maxLength={WA_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
              <p className="text-right text-xs text-muted">
                {text.length} / {WA_TEXT_MAX}
              </p>
            </div>
          )}
          <div>
            <label className="label" htmlFor={`${id}-file`}>
              <Paperclip size={14} className="mr-1 inline" aria-hidden />
              Attachment (optional)
            </label>
            <input
              id={`${id}-file`}
              type="file"
              className="text-sm"
              accept={Object.keys(WA_ATTACHMENT_TYPES).join(",")}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setFileError(f && !(f.type in WA_ATTACHMENT_TYPES) ? "Attach a JPEG, PNG or WebP image, or a PDF." : f && f.size > WA_ATTACHMENT_MAX_BYTES ? "Attachments can be at most 3 MB." : null);
              }}
            />
            {fileError && <p className="text-xs text-danger">{fileError}</p>}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={asked} onChange={(e) => setAsked(e.target.checked)} />
            <span>
              The customer asked to be messaged on WhatsApp
              <span className="block text-xs text-muted">Recorded as their consent, with your name. Leave it unticked unless they did.</span>
            </span>
          </label>
          <p className="text-xs text-muted">
            bizinsights checks first that this customer hasn&apos;t opted out and that the reason allows it ({plural(overview.limits.dailyLimit - overview.limits.sentToday, "message")} left today).
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!ready || busy === "send"}>
              {busy === "send" ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
