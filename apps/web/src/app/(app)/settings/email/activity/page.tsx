"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { errorLabel, MESSAGE_STATUS_HELP, MESSAGE_STATUS_LABEL, MESSAGE_STATUSES, PROVIDER_LABEL, type EmailProvider, type MessageStatus } from "@app/shared/email";
import { FactsLine, ROW, TableCard, TableHead, TD, Th } from "@/components/automations/MarketingKit";
import { MessageStatusBadge, providerLabel } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Modal } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { api, useApi, type ApiError } from "@/lib/api";
import { fmtDateTime, isoDay, useEmail, type AccountsResponse, type MessageDetail, type MessageRow, type RuleView } from "@/lib/email";

type Preset = "today" | "yesterday" | "week" | "month" | "last_month" | "custom";
const PRESETS: Array<[Preset, string]> = [
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["week", "This week"],
  ["month", "This month"],
  ["last_month", "Previous month"],
  ["custom", "Custom range"],
];

/** The preset as a day range in the viewer's own calendar (`to` inclusive). */
function presetRange(p: Preset, custom: { from: string; to: string }): { from: string; to: string } | null {
  const now = new Date();
  const day = (d: Date) => isoDay(d);
  const add = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  switch (p) {
    case "today":
      return { from: day(now), to: day(now) };
    case "yesterday":
      return { from: day(add(now, -1)), to: day(add(now, -1)) };
    case "week": {
      const monday = add(now, -((now.getDay() + 6) % 7));
      return { from: day(monday), to: day(now) };
    }
    case "month":
      return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to: day(now) };
    case "last_month":
      return { from: day(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: day(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case "custom":
      return custom.from && custom.to && custom.from <= custom.to ? custom : null;
  }
}

export default function EmailActivityPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <Activity />
    </Suspense>
  );
}

function Activity() {
  const { base, activity, automate } = useEmail();
  const params = useSearchParams();
  const [preset, setPreset] = useState<Preset>("month");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [status, setStatus] = useState<string>(params.get("status") ?? "");
  const [accountId, setAccountId] = useState("");
  const [provider, setProvider] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const accounts = useApi<AccountsResponse>(`${base}/accounts`);
  const rules = useApi<{ automations: RuleView[] }>(`${base}/automations`);
  const range = presetRange(preset, custom);
  // Days in the viewer's own calendar, sent as instants: local midnight to the next local midnight.
  const instants = range ? { from: new Date(`${range.from}T00:00:00`).toISOString(), to: new Date(new Date(`${range.to}T00:00:00`).getTime() + 86_400_000).toISOString() } : null;
  const query = instants
    ? new URLSearchParams({ from: instants.from, to: instants.to, limit: "50", ...(status ? { status } : {}), ...(accountId ? { accountId } : {}), ...(provider ? { provider } : {}), ...(ruleId ? { ruleId } : {}), ...(recipientQuery ? { recipient: recipientQuery } : {}) }).toString()
    : null;
  // Answers to an older filter are dropped: only the latest request may fill the table.
  const latest = useRef(0);

  const load = useCallback(
    async (cursor: string | null) => {
      if (!query) return;
      const ticket = ++latest.current;
      setLoading(true);
      try {
        const r = await api<{ messages: MessageRow[]; nextCursor: string | null }>(`${base}/messages?${query}${cursor ? `&cursor=${cursor}` : ""}`);
        if (ticket !== latest.current) return;
        setRows((prev) => (cursor ? [...prev, ...r.messages] : r.messages));
        setNext(r.nextCursor);
        setError(null);
      } catch (e) {
        if (ticket === latest.current) setError(e as ApiError);
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [base, query],
  );
  useEffect(() => {
    if (activity) void load(null);
  }, [load, activity]);

  if (!activity) return <Alert kind="info">Your role doesn&apos;t include the email activity log (it shows recipients&apos; addresses).</Alert>;

  return (
    <div className="space-y-4">
      <PageHeader title="Email activity" sub="Every email bizinsights sent or tried to send, newest first. Providers confirm acceptance; delivery to the inbox isn't reported to bizinsights." />
      {/* The filters on one white bar, then the history as a table, as the Stitch design's Results (screen 17) draws them. */}
      <section aria-label="Filters" role="search" className="home-card animate-rise grid gap-3 p-4 sm:grid-cols-3 sm:p-5 lg:grid-cols-6">
        <label>
          <span className="label text-xs text-muted">Period</span>
          <select aria-label="Period" className="input" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {PRESETS.map(([p, l]) => (
              <option key={p} value={p}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {preset === "custom" && (
          <>
            <label>
              <span className="label text-xs text-muted">From</span>
              <input aria-label="From" type="date" className="input" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </label>
            <label>
              <span className="label text-xs text-muted">To</span>
              <input aria-label="To" type="date" className="input" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </label>
          </>
        )}
        <label>
          <span className="label text-xs text-muted">Status</span>
          <select aria-label="Status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {MESSAGE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {MESSAGE_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label text-xs text-muted">Account</span>
          <select aria-label="Sending account" className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All</option>
            {accounts.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label text-xs text-muted">Provider</span>
          <select aria-label="Provider" className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">All</option>
            {Object.entries(PROVIDER_LABEL).map(([p, l]) => (
              <option key={p} value={p}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label text-xs text-muted">Automation</span>
          <select aria-label="Automation" className="input" value={ruleId} onChange={(e) => setRuleId(e.target.value)}>
            <option value="">All</option>
            {rules.data?.automations.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="sm:col-span-3 lg:col-span-6"
          onSubmit={(e) => {
            e.preventDefault();
            setRecipientQuery(recipient.trim());
          }}
        >
          <span className="label text-xs text-muted">Recipient (exact address)</span>
          <div className="flex gap-2">
            <input aria-label="Recipient email address" className="input" type="email" value={recipient} placeholder="customer@example.com" onChange={(e) => setRecipient(e.target.value)} />
            <button className="btn-secondary">Search</button>
            {recipientQuery && (
              <button type="button" className="btn-secondary" onClick={() => { setRecipient(""); setRecipientQuery(""); }}>
                Clear
              </button>
            )}
          </div>
        </form>
      </section>
      {!range ? (
        <Alert kind="info">Choose a start date on or before the end date.</Alert>
      ) : error && !rows.length ? (
        <LoadError what="the activity log" error={error} onRetry={() => load(null)} busy={loading} />
      ) : loading && !rows.length ? (
        <Skeleton lines={6} />
      ) : rows.length === 0 ? (
        <EmptyState title="No emails match" body="Try a longer period or fewer filters." />
      ) : (
        <TableCard id="email-activity" title="Emails" aside={<FactsLine items={[`${rows.length.toLocaleString()} shown`, next ? "older ones below" : null, "newest first"]} />}>
          {/* Phones: each email a stacked row instead of a wide table. */}
          <ul className="divide-y divide-home-line border-t border-home-line sm:hidden" aria-label="Emails">
            {rows.map((m) => (
              <li key={m.id}>
                <button type="button" className="block w-full px-5 py-3 text-left text-sm outline-none hover:bg-home-soft focus-visible:bg-home-soft" onClick={() => setOpenId(m.id)}>
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate font-medium">{m.subject}</span>
                    <MessageStatusBadge status={m.status} />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">
                    {fmtDateTime(m.createdAt)} · {m.recipient}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {m.rule ?? (m.kind === "test" ? "Test" : m.kind === "verification" ? "Sender verification" : "—")} · {providerLabel(m.provider)}
                  </span>
                  {m.errorCode && <span className="mt-0.5 block text-xs text-muted">{errorLabel(m.errorCode)}</span>}
                </button>
              </li>
            ))}
          </ul>
          <table className="hidden w-full min-w-[52rem] text-sm sm:table" aria-label="Emails">
            <TableHead>
              <Th>When</Th>
              <Th>Recipient</Th>
              <Th>Sender</Th>
              <Th>Automation</Th>
              <Th>Subject</Th>
              <Th>Status</Th>
              <Th>Provider</Th>
            </TableHead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={`${ROW} cursor-pointer hover:bg-home-soft`} onClick={() => setOpenId(m.id)}>
                  <td className={`${TD} whitespace-nowrap text-xs`}>
                    {/* The row opens on a click; the time is its button for the keyboard. */}
                    <button type="button" className="rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent" onClick={(e) => { e.stopPropagation(); setOpenId(m.id); }}>
                      {fmtDateTime(m.createdAt)}
                    </button>
                  </td>
                  <td className={`${TD} max-w-[12rem] truncate`}>{m.recipient}</td>
                  <td className={`${TD} max-w-[12rem] truncate text-xs`}>{m.sender}</td>
                  <td className={`${TD} min-w-[9rem] text-xs`}>{m.rule ?? (m.kind === "test" ? "Test" : m.kind === "verification" ? "Sender verification" : "—")}</td>
                  <td className={`${TD} max-w-[16rem] truncate`}>{m.subject}</td>
                  <td className={TD}>
                    <MessageStatusBadge status={m.status} />
                    {m.errorCode && <span className="block text-xs text-muted">{errorLabel(m.errorCode)}</span>}
                  </td>
                  <td className={`${TD} text-xs`}>{providerLabel(m.provider)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {next && (
            <div className="border-t border-home-line p-3 text-center">
              <button className="btn-secondary" disabled={loading} onClick={() => load(next)}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </TableCard>
      )}
      <MessageModal id={openId} canAct={automate} onClose={() => setOpenId(null)} onChanged={() => load(null)} />
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  queued: "Queued",
  processing: "Handed to the provider",
  accepted: "Accepted by the provider",
  retry_scheduled: "Temporary failure: retry scheduled",
  held: "Held (limit, paused or account issue)",
  failed: "Failed",
  bounced: "Bounced",
  suppressed: "Suppressed",
  cancelled: "Cancelled",
  unknown: "Outcome unknown",
  delivered: "Delivered",
};

function MessageModal({ id, canAct, onClose, onChanged }: { id: string | null; canAct: boolean; onClose: () => void; onChanged: () => void }) {
  const { base } = useEmail();
  const { data, error, loading, reload, setData } = useApi<{ message: MessageDetail }>(id ? `${base}/messages/${id}` : null);
  const { busy, run } = useAction();
  const m = data?.message;
  return (
    <Modal open={!!id} title="Email details" wide onClose={onClose}>
      {error && !data ? (
        <LoadError what="the email" error={error} onRetry={reload} busy={loading} />
      ) : !m ? (
        <Skeleton lines={5} />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <MessageStatusBadge status={m.status} />
            <span className="text-xs text-muted">{MESSAGE_STATUS_HELP[m.status as MessageStatus]}</span>
          </div>
          {m.errorCode && <Alert>{errorLabel(m.errorCode)}{m.errorMessage ? ` (${m.errorMessage})` : ""}</Alert>}
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 rounded bg-home-soft p-3 sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">To</dt>
            <dd className="break-all">{m.recipient}</dd>
            <dt className="text-muted">From</dt>
            <dd className="break-all">{m.sender} ({PROVIDER_LABEL[m.provider as EmailProvider] ?? m.provider})</dd>
            <dt className="text-muted">Subject</dt>
            <dd>{m.subject}</dd>
            <dt className="text-muted">Automation</dt>
            <dd>{m.rule ?? "—"}</dd>
            <dt className="text-muted">Template</dt>
            <dd>{m.template ? `${m.template} (v${m.templateVersion})` : "—"}</dd>
            <dt className="text-muted">Type</dt>
            <dd>{m.category === "marketing" ? "Marketing" : "Transactional"}</dd>
            <dt className="text-muted">Attempts</dt>
            <dd>
              {m.attempts} of {m.maxAttempts}
            </dd>
            <dt className="text-muted">Message-ID</dt>
            <dd className="break-all font-mono text-xs">{m.messageIdHeader}</dd>
            <dt className="text-muted">Provider id</dt>
            <dd className="break-all font-mono text-xs">{m.providerMessageId ?? "—"}</dd>
          </dl>
          <div>
            <h3 className="font-semibold">History</h3>
            <ol className="mt-1 space-y-1">
              {m.events.map((e, i) => (
                <li key={i} className="flex gap-3 text-xs">
                  <span className="w-36 shrink-0 text-muted">{fmtDateTime(e.at)}</span>
                  <span>
                    {EVENT_LABEL[e.type] ?? e.type}
                    {typeof e.metadata?.code === "string" ? ` · ${errorLabel(e.metadata.code)}` : ""}
                    {typeof e.metadata?.retryAt === "string" ? ` · next try ${fmtDateTime(e.metadata.retryAt)}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {canAct && m.kind === "automation" && (m.status === "failed" || m.status === "unknown") && (
            <div className="space-y-2 border-t border-home-line pt-3">
              {m.status === "unknown" && <p className="text-xs text-muted">The provider may already have this email. Sending it again could deliver it twice.</p>}
              <button
                className="btn-primary"
                disabled={!!busy}
                onClick={() =>
                  run("retry", "retry the email", async () => {
                    const r = await api<{ message: MessageDetail }>(`${base}/messages/${m.id}/retry`, { method: "POST" });
                    setData(r);
                    onChanged();
                    return "Queued to send again.";
                  })
                }
              >
                Send again
              </button>
            </div>
          )}
          {canAct && (m.status === "queued" || m.status === "deferred") && (
            <button
              className="btn-secondary text-danger"
              disabled={!!busy}
              onClick={() =>
                run("cancel", "cancel the email", async () => {
                  const r = await api<{ message: MessageDetail }>(`${base}/messages/${m.id}/cancel`, { method: "POST" });
                  setData(r);
                  onChanged();
                  return "Cancelled.";
                })
              }
            >
              Cancel this email
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
