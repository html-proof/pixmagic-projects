"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { libraryTemplate, OCCASIONS, type Audience, type TemplateMapping } from "@app/shared/whatsapp";
import { Badge, Empty, type Tone } from "@/components/dashboard/primitives";
import { LoadError } from "@/components/LoadError";
import { ApiError, actionError, api, fmtMoney, fmtNum, fmtPct, useApi } from "@/lib/api";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { ConfirmDialog, fmtWhen, PageHeader, Skeleton, TemplateMapper, useAction, useToast, useWa, type SettingsResponse } from "@/components/whatsapp/common";
import type { Overview } from "@/components/whatsapp/types";

interface Metrics {
  recipients: number;
  waiting: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  clicks: number;
  conversions: number;
  revenue: number;
  codeOrders: { orders: number; revenue: number } | null;
}
interface Campaign {
  id: string;
  name: string;
  occasion: string;
  objective: string | null;
  templateName: string;
  templateLanguage: string;
  mapping: TemplateMapping;
  variables: { greeting?: string; discountPercentage?: string; endDate?: string };
  mediaUrl: string | null;
  linkUrl: string | null;
  discountCode: string | null;
  audience: Audience;
  startAt: string;
  endAt: string | null;
  status: "draft" | "scheduled" | "sending" | "paused" | "completed" | "cancelled";
  estimatedRecipients: number | null;
  approvedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metrics: Metrics | null;
}

const STATUS: Record<Campaign["status"], { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  scheduled: { tone: "neutral", label: "Scheduled" },
  sending: { tone: "good", label: "Sending" },
  paused: { tone: "warn", label: "Paused" },
  completed: { tone: "good", label: "Finished" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

const SEGMENTS: Array<[Audience["segment"], string]> = [
  ["all_opted_in", "Everyone who opted in"],
  ["recent_buyers", "Bought recently"],
  ["lapsed_buyers", "Haven't bought for a while"],
  ["repeat_buyers", "Bought more than once"],
  ["high_spenders", "Spent at least…"],
];

/** "2026-10-10T09:30" in the browser's own zone, for datetime-local inputs. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

type Draft = Omit<Campaign, "id" | "status" | "estimatedRecipients" | "approvedAt" | "startedAt" | "completedAt" | "metrics">;

const blank = (): Draft => {
  const lib = libraryTemplate("insights_seasonal_offer")!;
  return {
    name: "",
    occasion: "onam",
    objective: "",
    templateName: "",
    templateLanguage: "en",
    mapping: lib.mapping,
    variables: { greeting: "Happy Onam", discountPercentage: "", endDate: "" },
    mediaUrl: "",
    linkUrl: "",
    discountCode: "",
    audience: { segment: "all_opted_in", days: 90, minSpend: 0, countries: [] },
    startAt: new Date(Date.now() + 86_400_000).toISOString(),
    endAt: null,
  };
};

function Editor({ initial, id, templates, onClose }: { initial: Draft; id: string | null; templates: SettingsResponse["templates"]; onClose: (saved: boolean) => void }) {
  const { base } = useWa();
  const [d, setD] = useState<Draft>(initial);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const audienceKey = JSON.stringify(d.audience);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api<{ recipients: number }>(`${base}/campaigns/estimate`, { method: "POST", body: { audience: d.audience } })
        .then((r) => live && setEstimate(r.recipients))
        .catch(() => live && setEstimate(null));
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // The audience is what changes the count.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, audienceKey]);
  const t = templates.find((x) => x.name === d.templateName && x.language === d.templateLanguage);
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = {
      ...d,
      objective: d.objective || null,
      mediaUrl: d.mediaUrl || null,
      linkUrl: d.linkUrl || null,
      discountCode: d.discountCode || null,
      variables: Object.fromEntries(Object.entries(d.variables).filter(([, v]) => v)),
      endAt: d.endAt || null,
    };
    try {
      await api(id ? `${base}/campaigns/${id}` : `${base}/campaigns`, { method: id ? "PATCH" : "POST", body });
      toast("success", "Campaign saved as a draft. Schedule it when you're ready.");
      onClose(true);
    } catch (e) {
      setError(actionError(e, "save the campaign"));
    } finally {
      setBusy(false);
    }
  };
  const a = d.audience;
  return (
    <section className="card animate-rise border-accent/40" aria-labelledby="ed-h">
      <h2 id="ed-h" className="font-semibold">{id ? "Edit campaign" : "New campaign"}</h2>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="c-name">Campaign name</label>
            <input id="c-name" className="input" maxLength={120} required value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Onam festival offers" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="c-occ">Occasion</label>
              <select
                id="c-occ"
                className="input"
                value={d.occasion}
                onChange={(e) => {
                  const o = OCCASIONS.find((x) => x.id === e.target.value)!;
                  setD({ ...d, occasion: o.id, variables: { ...d.variables, greeting: o.greeting } });
                }}
              >
                {OCCASIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="c-greet">Greeting</label>
              <input id="c-greet" className="input" maxLength={60} value={d.variables.greeting ?? ""} onChange={(e) => setD({ ...d, variables: { ...d.variables, greeting: e.target.value } })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="c-obj">Objective (for you)</label>
            <input id="c-obj" className="input" maxLength={300} value={d.objective ?? ""} onChange={(e) => setD({ ...d, objective: e.target.value })} placeholder="Clear festive stock, bring back last year's buyers…" />
          </div>
          <TemplateMapper
            templates={templates}
            category="MARKETING"
            templateName={d.templateName || null}
            language={d.templateLanguage}
            mapping={d.mapping}
            onChange={(n) => setD({ ...d, templateName: n.templateName ?? "", templateLanguage: n.language, mapping: n.templateName && libraryTemplate(n.templateName) && n.mapping.body.length === 0 ? libraryTemplate(n.templateName)!.mapping : n.mapping })}
          />
        </div>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="c-disc">Discount %</label>
              <input id="c-disc" className="input" inputMode="numeric" maxLength={2} value={d.variables.discountPercentage ?? ""} onChange={(e) => setD({ ...d, variables: { ...d.variables, discountPercentage: e.target.value.replace(/\D/g, "") } })} />
            </div>
            <div>
              <label className="label" htmlFor="c-code">Discount code</label>
              <input id="c-code" className="input font-mono uppercase" maxLength={40} value={d.discountCode ?? ""} onChange={(e) => setD({ ...d, discountCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
              <p className="mt-1 text-xs text-muted">Create it in Shopify first. Orders using it are counted.</p>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="c-link">Product or collection link</label>
            <input id="c-link" className="input" type="url" placeholder="https://yourstore.com/collections/onam" value={d.linkUrl ?? ""} onChange={(e) => setD({ ...d, linkUrl: e.target.value })} />
            <p className="mt-1 text-xs text-muted">The button opens this through a tracked link, so clicks can be counted.</p>
          </div>
          {t?.shape.headerFormat === "IMAGE" && (
            <div>
              <label className="label" htmlFor="c-img">Header image (https link to a JPG or PNG)</label>
              <input id="c-img" className="input" type="url" value={d.mediaUrl ?? ""} onChange={(e) => setD({ ...d, mediaUrl: e.target.value })} />
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="c-start">Start</label>
              <input id="c-start" className="input" type="datetime-local" value={toLocalInput(d.startAt)} onChange={(e) => e.target.value && setD({ ...d, startAt: new Date(e.target.value).toISOString() })} />
            </div>
            <div>
              <label className="label" htmlFor="c-end">End (optional)</label>
              <input id="c-end" className="input" type="datetime-local" value={toLocalInput(d.endAt)} onChange={(e) => setD({ ...d, endAt: e.target.value ? new Date(e.target.value).toISOString() : null, variables: { ...d.variables, endDate: e.target.value ? new Date(e.target.value).toLocaleDateString(undefined, { day: "numeric", month: "long" }) : d.variables.endDate } })} />
              <p className="mt-1 text-xs text-muted">Unsent messages are cancelled at the end.</p>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="c-until">&ldquo;Offer valid until&rdquo; text</label>
            <input id="c-until" className="input" maxLength={40} value={d.variables.endDate ?? ""} onChange={(e) => setD({ ...d, variables: { ...d.variables, endDate: e.target.value } })} />
          </div>
          <fieldset className="rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">Audience</legend>
            <select aria-label="Segment" className="input" value={a.segment} onChange={(e) => setD({ ...d, audience: { ...a, segment: e.target.value as Audience["segment"] } })}>
              {SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {(a.segment === "recent_buyers" || a.segment === "lapsed_buyers") && (
              <label className="mt-2 block text-sm">
                {a.segment === "recent_buyers" ? "Bought within the last" : "No order in the last"}{" "}
                <input className="input inline-block w-20" type="number" min={1} max={730} value={a.days} onChange={(e) => setD({ ...d, audience: { ...a, days: Number(e.target.value) || 1 } })} /> days
              </label>
            )}
            {a.segment === "high_spenders" && (
              <label className="mt-2 block text-sm">
                Orders totalling at least <input className="input inline-block w-28" type="number" min={0} value={a.minSpend} onChange={(e) => setD({ ...d, audience: { ...a, minSpend: Number(e.target.value) || 0 } })} />
              </label>
            )}
            <label className="mt-2 block text-sm">
              Only numbers from (country codes, comma separated, optional){" "}
              <input
                className="input"
                placeholder="IN, AE"
                value={a.countries.join(", ")}
                onChange={(e) => setD({ ...d, audience: { ...a, countries: e.target.value.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)) } })}
              />
            </label>
            <p className="mt-2 text-sm">
              <strong>{estimate === null ? "…" : fmtNum(estimate)}</strong> customer{estimate === 1 ? "" : "s"} would get it right now.
            </p>
            <p className="text-xs text-muted">Only customers who opted in to WhatsApp marketing and haven&apos;t opted out. Purchase-based segments use orders received since WhatsApp was turned on.</p>
          </fieldset>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={busy || !d.name || !d.templateName} onClick={() => void save()}>{busy ? "Saving…" : "Save draft"}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
      </div>
    </section>
  );
}

function ScheduleDialog({ c, onClose }: { c: Campaign; onClose: (done: boolean) => void }) {
  const { base } = useWa();
  const toast = useToast();
  const { store } = useApp();
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ estimate: number | null }>(`${base}/campaigns/${c.id}`).then((r) => setCount(r.estimate ?? 0)).catch((e) => setError(actionError(e, "count the recipients")));
  }, [base, c.id]);
  const confirm = async () => {
    if (count === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/campaigns/${c.id}/schedule`, { method: "POST", body: { confirmRecipients: count } });
      toast("success", `Scheduled for ${fmtWhen(c.startAt, store?.timezone)} to ${fmtNum(count)} customers.`);
      onClose(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "recipients_changed") {
        // The audience moved while the dialog was open: show the new number and ask again.
        const fresh = await api<{ estimate: number | null }>(`${base}/campaigns/${c.id}`).catch(() => null);
        setCount(fresh?.estimate ?? null);
        setError("The number of customers changed. Check the new number and confirm again.");
      } else setError(actionError(e, "schedule the campaign"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog open title={`Schedule "${c.name}"?`} confirmLabel={count === null ? "Counting…" : `Send to ${fmtNum(count)} customers`} busy={busy || count === null} onCancel={() => onClose(false)} onConfirm={() => void confirm()}>
      {error && <Alert>{error}</Alert>}
      <p>
        Template <strong>{c.templateName}</strong>, starting <strong>{fmtWhen(c.startAt, store?.timezone)}</strong>
        {c.endAt ? <>, ending {fmtWhen(c.endAt, store?.timezone)}</> : null}.
      </p>
      <p>
        It goes to <strong>{count === null ? "…" : fmtNum(count)}</strong> customers who opted in to WhatsApp marketing. Anyone who opts out before their message goes is skipped;
        messages only go out in your sending hours, and never more than your weekly limit per customer.
      </p>
      <p>WhatsApp charges per delivered marketing message (rates depend on the customer&apos;s country, see WhatsApp Manager).</p>
    </ConfirmDialog>
  );
}

export default function Campaigns() {
  const { base, manage } = useWa();
  const { store } = useApp();
  const overview = useApi<Overview>(base);
  const settings = useApi<SettingsResponse>(base ? `${base}/settings` : null);
  const { data, error, reload } = useApi<{ campaigns: Campaign[] }>(base ? `${base}/campaigns` : null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [scheduling, setScheduling] = useState<Campaign | null>(null);
  const { busy, run } = useAction();
  const loadError = error ?? overview.error ?? settings.error;
  if (loadError) return <LoadError what="your campaigns" error={loadError} onRetry={() => void Promise.all([reload(), overview.reload(), settings.reload()])} />;
  if (!data || !overview.data || !settings.data) return <Skeleton lines={5} />;
  const conn = overview.data.connection;
  const locked = !conn ? "Connect WhatsApp first." : !conn.registered ? "Register your number first (Connect WhatsApp)." : !conn.webhookVerifiedAt ? "Finish the webhook step on Connect WhatsApp first: without it, opt-out replies couldn't reach Insights." : null;
  const marketingTemplates = settings.data.templates.filter((t) => t.category === "MARKETING" && t.status === "APPROVED");
  const act = (c: Campaign, action: "pause" | "resume" | "cancel" | "delete") =>
    run(`${c.id}-${action}`, `${action} the campaign`, async () => {
      if (action === "delete") await api(`${base}/campaigns/${c.id}`, { method: "DELETE" });
      else await api(`${base}/campaigns/${c.id}/${action}`, { method: "POST" });
      await reload();
      return { pause: "Paused.", resume: "Resumed.", cancel: "Cancelled; nothing more is sent.", delete: "Deleted." }[action];
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Marketing campaigns"
        sub="Seasonal and promotional messages to customers who opted in to WhatsApp marketing. Nothing is sent just because a festival is near: you write each campaign, check who gets it, and schedule it yourself."
        actions={manage && !editing ? <button type="button" className="btn-primary" onClick={() => setEditing({ id: null, draft: blank() })}>New campaign</button> : undefined}
      />
      {locked && <Alert kind="info">{locked} You can still prepare drafts.</Alert>}
      {!marketingTemplates.length && (
        <Alert kind="info">
          Campaigns need a template Meta approved as <strong>marketing</strong>. Add &ldquo;Seasonal offer&rdquo; on <Link className="underline" href="/whatsapp/templates">Message templates</Link>.
        </Alert>
      )}

      {editing && (
        <Editor
          id={editing.id}
          initial={editing.draft}
          templates={settings.data.templates}
          onClose={(saved) => {
            setEditing(null);
            if (saved) void reload();
          }}
        />
      )}

      {!data.campaigns.length && !editing ? (
        <Empty>No campaigns yet.</Empty>
      ) : (
        <ul className="space-y-3">
          {data.campaigns.map((c) => {
            const m = c.metrics;
            const st = STATUS[c.status];
            return (
              <li key={c.id} className="card animate-rise">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {c.name} <Badge tone={st.tone}>{st.label}</Badge>
                      <span className="text-xs font-normal text-muted">{OCCASIONS.find((o) => o.id === c.occasion)?.label}</span>
                    </p>
                    <p className="text-xs text-muted">
                      {c.templateName} · starts {fmtWhen(c.startAt, store?.timezone)}
                      {c.endAt ? ` · ends ${fmtWhen(c.endAt, store?.timezone)}` : ""}
                      {c.discountCode ? ` · code ${c.discountCode}` : ""}
                      {c.status === "scheduled" && c.estimatedRecipients !== null ? ` · ${fmtNum(c.estimatedRecipients)} confirmed recipients` : ""}
                    </p>
                    {c.objective && <p className="mt-1 text-sm text-muted">{c.objective}</p>}
                  </div>
                  {manage && (
                    <div className="flex flex-wrap gap-2">
                      {(c.status === "draft" || c.status === "scheduled") && (
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setEditing({ id: c.id, draft: { ...c, objective: c.objective ?? "", mediaUrl: c.mediaUrl ?? "", linkUrl: c.linkUrl ?? "", discountCode: c.discountCode ?? "" } })}>
                          Edit
                        </button>
                      )}
                      {c.status === "draft" && (
                        <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!locked} title={locked ?? undefined} onClick={() => setScheduling(c)}>
                          Schedule…
                        </button>
                      )}
                      {(c.status === "scheduled" || c.status === "sending") && (
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void act(c, "pause")}>Pause</button>
                      )}
                      {c.status === "paused" && (
                        <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void act(c, "resume")}>Resume</button>
                      )}
                      {["scheduled", "sending", "paused"].includes(c.status) && (
                        <button type="button" className="btn-danger h-8 px-3 text-xs" disabled={!!busy} onClick={() => window.confirm(`Cancel "${c.name}"? Messages not yet sent won't be.`) && void act(c, "cancel")}>
                          Cancel campaign
                        </button>
                      )}
                      {c.status === "draft" && (
                        <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => window.confirm(`Delete the draft "${c.name}"?`) && void act(c, "delete")}>Delete</button>
                      )}
                    </div>
                  )}
                </div>
                {m && m.recipients > 0 && (
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 lg:grid-cols-8">
                    {[
                      ["Recipients", fmtNum(m.recipients)],
                      ["Sent", fmtNum(m.sent)],
                      ["Delivered", `${fmtNum(m.delivered)}${m.sent ? ` (${fmtPct(m.delivered / m.sent)})` : ""}`],
                      ["Read", m.read ? fmtNum(m.read) : "—"],
                      ["Failed / not sent", `${fmtNum(m.failed)} / ${fmtNum(m.skipped)}`],
                      ["Link clicks", fmtNum(m.clicks)],
                      ["Orders after", fmtNum(m.conversions)],
                      ["Their value", fmtMoney(m.revenue, store?.currency ?? "USD")],
                    ].map(([k, v]) => (
                      <div key={k}>
                        <dt className="text-xs text-muted">{k}</dt>
                        <dd className="font-medium">{v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {m?.codeOrders && (
                  <p className="mt-2 text-xs text-muted">
                    Orders using {c.discountCode}: {fmtNum(m.codeOrders.orders)} ({fmtMoney(m.codeOrders.revenue, store?.currency ?? "USD")}), from anyone, not only recipients.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted">
        &ldquo;Orders after&rdquo; counts an order once, for the last campaign message its customer received within {settings.data.config.attributionDays} days before buying
        (change this in Settings). It shows what followed a message, not that the message caused the purchase. Read counts only include customers who share read receipts.
      </p>
      {scheduling && (
        <ScheduleDialog
          c={scheduling}
          onClose={(done) => {
            setScheduling(null);
            if (done) void reload();
          }}
        />
      )}
    </div>
  );
}
