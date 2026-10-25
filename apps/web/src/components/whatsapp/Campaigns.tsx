"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { CAMPAIGN_VARIABLES, describeAudience, type CampaignAudience, type TemplateMapping } from "@app/shared/whatsapp";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Stat } from "@/components/dashboard/Primitives";
import { Alert, EmptyState } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { CountryPicker, fmtWhen, plural } from "@/components/messaging/MessagingUi";
import { fitMapping, MappingEditor } from "./MappingEditor";
import type { WaCampaign, WaCampaignDetail, WaOverview, WaTemplatesAnswer } from "./types";
import { CAMPAIGN_STATUS, Pill, problemsOf, reasonText, useWaAction, waError, waHref } from "./WaUi";

const emptyAudience: CampaignAudience = { countries: [], customerType: "any", orderedWithinDays: null, notOrderedForDays: null, minOrders: null, minSpent: null };

const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.round(Number(v))) || null);

/** Write or edit a draft: the template and its blanks, and who receives it, with a live count. */
function CampaignEditor({ base, editing, templates, onDone, onCancel }: { base: string; editing: WaCampaign | null; templates: WaTemplatesAnswer["templates"]; onDone: (id: string) => void; onCancel: () => void }) {
  const marketing = templates.filter((t) => t.category === "MARKETING" && t.status === "APPROVED");
  const [name, setName] = useState(editing?.name ?? "");
  const [ref, setRef] = useState(editing ? `${editing.template.name}|${editing.template.language}` : "");
  const template = marketing.find((t) => `${t.name}|${t.language}` === ref) ?? null;
  const [mapping, setMapping] = useState<TemplateMapping>(editing?.mapping ?? { body: [], buttons: [] });
  const [media, setMedia] = useState(editing?.headerMediaUrl ?? "");
  const [audience, setAudience] = useState<CampaignAudience>(editing?.audience ?? emptyAudience);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useWaAction();

  useEffect(() => {
    let stale = false;
    const t = window.setTimeout(() => {
      api<{ count: number }>(`${base}/campaigns/estimate`, { method: "POST", body: { audience } })
        .then((r) => !stale && setEstimate(r.count))
        .catch(() => !stale && setEstimate(null));
    }, 400);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [audience, base]);

  const save = () =>
    run("save", "save the campaign", async () => {
      setError(null);
      const body = { name, template: template ? { name: template.name, language: template.language } : { name: "", language: "en" }, mapping, headerMediaUrl: media.trim() || null, audience };
      try {
        const r = editing ? await api<{ campaign: { id: string } }>(`${base}/campaigns/${editing.id}`, { method: "PUT", body }) : await api<{ campaign: { id: string } }>(`${base}/campaigns`, { method: "POST", body });
        onDone(r.campaign.id);
        return "Campaign saved as a draft.";
      } catch (e) {
        setError(waError(e, "save the campaign"));
        throw e;
      }
    });

  return (
    <div className="space-y-4">
      <section className="card animate-rise space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{editing ? `Edit "${editing.name}"` : "New campaign"}</h2>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Back to campaigns
          </button>
        </div>
        <div className="max-w-md">
          <label className="label" htmlFor="cmp-name">
            Name (only your team sees it)
          </label>
          <input id="cmp-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer" />
        </div>
      </section>
      <section className="card animate-rise space-y-3" aria-labelledby="cmp-msg-h">
        <h3 id="cmp-msg-h" className="font-semibold">
          Message
        </h3>
        {!marketing.length ? (
          <Alert kind="info">Campaigns need a template Meta approved as Marketing. Write one in Templates (the &ldquo;Promotion&rdquo; starter is a good start) and come back once it&apos;s approved.</Alert>
        ) : (
          <>
            <div className="max-w-md">
              <label className="label" htmlFor="cmp-tpl">
                Approved marketing template
              </label>
              <select
                id="cmp-tpl"
                className="input"
                value={ref}
                onChange={(e) => {
                  setRef(e.target.value);
                  const t = marketing.find((x) => `${x.name}|${x.language}` === e.target.value) ?? null;
                  setMapping(fitMapping(t, null, CAMPAIGN_VARIABLES));
                }}
              >
                <option value="">Choose a template…</option>
                {marketing.map((t) => (
                  <option key={t.id} value={`${t.name}|${t.language}`}>
                    {t.name} ({t.language})
                  </option>
                ))}
              </select>
            </div>
            {template && <MappingEditor template={template} mapping={mapping} onChange={setMapping} allowed={CAMPAIGN_VARIABLES} headerMediaUrl={media} onHeaderMediaUrl={setMedia} />}
          </>
        )}
      </section>
      <section className="card animate-rise space-y-3" aria-labelledby="cmp-aud-h">
        <h3 id="cmp-aud-h" className="font-semibold">
          Who receives it
        </h3>
        <p className="text-sm text-muted">Only customers who agreed to WhatsApp marketing and never replied STOP. Narrow it down if you like.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="cmp-type">
              Customers
            </label>
            <select id="cmp-type" className="input" value={audience.customerType} onChange={(e) => setAudience({ ...audience, customerType: e.target.value as CampaignAudience["customerType"] })}>
              <option value="any">Everyone</option>
              <option value="new">With one order</option>
              <option value="returning">Who ordered more than once</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="cmp-within">
              Ordered in the last … days
            </label>
            <input id="cmp-within" className="input" type="number" min={1} value={audience.orderedWithinDays ?? ""} onChange={(e) => setAudience({ ...audience, orderedWithinDays: num(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="cmp-notfor">
              Haven&apos;t ordered for … days
            </label>
            <input id="cmp-notfor" className="input" type="number" min={1} value={audience.notOrderedForDays ?? ""} onChange={(e) => setAudience({ ...audience, notOrderedForDays: num(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="cmp-minorders">
              At least … orders
            </label>
            <input id="cmp-minorders" className="input" type="number" min={1} value={audience.minOrders ?? ""} onChange={(e) => setAudience({ ...audience, minOrders: num(e.target.value) })} />
          </div>
          <div>
            <label className="label" htmlFor="cmp-minspent">
              Spent at least
            </label>
            <input id="cmp-minspent" className="input" type="number" min={0} value={audience.minSpent ?? ""} onChange={(e) => setAudience({ ...audience, minSpent: e.target.value.trim() === "" ? null : Math.max(0, Number(e.target.value)) || null })} />
          </div>
        </div>
        <CountryPicker label="Only in these countries (none: any country)" value={audience.countries} onChange={(countries) => setAudience({ ...audience, countries })} />
        <p className="text-sm" aria-live="polite">
          {describeAudience(audience)}: <strong>{estimate === null ? "counting…" : plural(estimate, "customer")}</strong> today.
        </p>
      </section>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={!name.trim() || !template || busy === "save"} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : "Save draft"}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** A campaign: what it needs before it can be sent, a test, scheduling, cancelling, and how it went. */
function CampaignView({ base, id, overview, onBack, onEdit, onDeleted }: { base: string; id: string; overview: WaOverview; onBack: () => void; onEdit: () => void; onDeleted: () => void }) {
  const { data, error, loading, reload } = useApi<WaCampaignDetail>(`${base}/campaigns/${id}`);
  const { busy, run } = useWaAction();
  const [scheduling, setScheduling] = useState<{ count: number } | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const can = overview.can;
  useEffect(() => {
    if (data?.campaign.status !== "sending") return;
    const t = window.setInterval(() => void reload(), 15_000);
    return () => window.clearInterval(t);
  }, [data?.campaign.status, reload]);
  if (error) return <LoadError what="the campaign" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data) return <Skeleton lines={5} />;
  const { campaign: c, report: r } = data;
  const list = problems.length ? problems : data.problems;
  const tz = overview.store.timezone;

  const startSchedule = () =>
    run("estimate", "count the recipients", async () => {
      const e = await api<{ count: number }>(`${base}/campaigns/estimate`, { method: "POST", body: { audience: c.audience } });
      setScheduling({ count: e.count });
    });
  const schedule = () =>
    run("schedule", "schedule the campaign", async () => {
      try {
        await api(`${base}/campaigns/${c.id}/schedule`, { method: "POST", body: { scheduledAt: when === "later" && at ? new Date(at).toISOString() : null, confirmRecipients: scheduling!.count } });
      } catch (e) {
        setProblems(problemsOf(e));
        setScheduling(null);
        throw e;
      }
      setScheduling(null);
      await reload();
      return when === "later" ? "Campaign scheduled." : "Campaign started: messages are going out now.";
    });

  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="flex flex-wrap items-center gap-2 font-semibold">
              {c.name} <Pill map={CAMPAIGN_STATUS} status={c.status} />
            </h2>
            <p className="mt-1 text-sm text-muted">
              {c.template.name} · {c.audienceText}
            </p>
            <p className="mt-1 text-xs text-muted">
              {c.status === "scheduled" && c.scheduledAt ? `Starts ${fmtWhen(c.scheduledAt, tz)}. ` : ""}
              {c.startedAt ? `Started ${fmtWhen(c.startedAt, tz)}. ` : ""}
              {c.completedAt ? `Finished ${fmtWhen(c.completedAt, tz)}. ` : ""}
              {c.cancelledAt ? `Cancelled ${fmtWhen(c.cancelledAt, tz)}${c.cancelReason && c.cancelReason !== "merchant" ? ` (${reasonText(c.cancelReason) ?? c.cancelReason})` : ""}. ` : ""}
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={onBack}>
            Back to campaigns
          </button>
        </div>
        {can.manage && (
          <div className="mt-3 flex flex-wrap gap-2">
            {c.can.schedule && (
              <button type="button" className="btn-primary" onClick={() => void startSchedule()} disabled={!!list.length || busy === "estimate"}>
                Schedule or send
              </button>
            )}
            {c.can.test && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === "test"}
                onClick={() =>
                  void run("test", "send the test", async () => {
                    await api(`${base}/campaigns/${c.id}/test`, { method: "POST", body: {} });
                    await reload();
                    return "Test sent to your own number.";
                  })
                }
              >
                Send a test to me
              </button>
            )}
            {c.can.edit && (
              <button type="button" className="btn-secondary" onClick={onEdit}>
                Edit
              </button>
            )}
            {c.can.cancel && (
              <button type="button" className="btn-secondary text-danger" onClick={() => setConfirmCancel(true)}>
                Cancel campaign
              </button>
            )}
            {c.can.delete && (
              <button type="button" className="btn-secondary text-danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )}
          </div>
        )}
        {c.can.schedule && !c.lastTestAt && can.manage && <p className="mt-2 text-xs text-muted">Tip: send yourself a test first to see exactly what customers will receive.</p>}
      </section>
      {c.can.schedule && list.length > 0 && (
        <Alert kind="info">
          <strong>Before it can be sent:</strong>
          <ul className="mt-1 list-disc pl-5">
            {list.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {c.status !== "draft" && (
        <section aria-labelledby="cmp-report-h" className="space-y-2">
          <h3 id="cmp-report-h" className="text-sm font-semibold">
            Delivery report {c.status === "sending" ? <span className="font-normal text-muted">(updates by itself)</span> : null}
          </h3>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Recipients" value={fmtNum(c.recipients || r.total)} note={c.status === "sending" && !c.materialized ? "Still adding recipients…" : c.estimatedRecipients ? `${fmtNum(c.estimatedRecipients)} when scheduled` : undefined} />
            <Stat label="Sent" value={fmtNum(r.sent + r.delivered + r.read)} note={r.queued ? `${fmtNum(r.queued)} waiting` : undefined} />
            <Stat label="Delivered" value={fmtNum(r.delivered + r.read)} tone={r.delivered + r.read ? "good" : undefined} note={r.read ? `${fmtNum(r.read)} read` : undefined} />
            <Stat label="Failed" value={fmtNum(r.failed)} tone={r.failed ? "danger" : undefined} note={r.skipped + r.cancelled ? `${fmtNum(r.skipped + r.cancelled)} not sent` : undefined} />
          </div>
          {c.recipients > 0 && (
            <div className="h-2 rounded-full bg-bg" aria-hidden>
              <div className="h-2 rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round(((r.total - r.queued) / Math.max(1, c.recipients)) * 100))}%` }} />
            </div>
          )}
          {r.failures.length > 0 && (
            <div className="card">
              <h4 className="text-sm font-semibold">Why some weren&apos;t sent</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {r.failures.map((f, i) => (
                  <li key={i}>
                    {fmtNum(f.count)} · {f.title ?? reasonText(f.reason) ?? "WhatsApp couldn't send them"}
                  </li>
                ))}
              </ul>
              <Link className="mt-2 inline-block text-sm text-accent underline-offset-2 hover:underline" href={waHref("activity", { campaignId: c.id, status: "failed" })}>
                See the failed messages
              </Link>
            </div>
          )}
        </section>
      )}
      <ConfirmDialog
        open={!!scheduling}
        title={`Send to ${scheduling ? plural(scheduling.count, "customer") : ""}?`}
        confirmLabel={when === "now" ? `Send to ${scheduling ? fmtNum(scheduling.count) : ""} now` : "Schedule"}
        busy={busy === "schedule"}
        confirmDisabled={when === "later" && !at}
        onCancel={() => setScheduling(null)}
        onConfirm={() => void schedule()}
      >
        <p>
          {c.audienceText}: <strong>{scheduling ? plural(scheduling.count, "customer") : ""}</strong> right now. Each message is checked again right before it goes, so anyone who opts out meanwhile won&apos;t
          receive it. Meta charges your business for each marketing conversation.
        </p>
        <fieldset className="space-y-2 text-text">
          <label className="flex items-center gap-2">
            <input type="radio" name="cmp-when" checked={when === "now"} onChange={() => setWhen("now")} /> Send now
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="cmp-when" checked={when === "later"} onChange={() => setWhen("later")} /> Schedule for
            <input type="datetime-local" className="input w-auto" aria-label="Date and time" value={at} onChange={(e) => setAt(e.target.value)} disabled={when !== "later"} />
          </label>
        </fieldset>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmCancel}
        title="Cancel this campaign?"
        confirmLabel="Cancel campaign"
        danger
        busy={busy === "cancel"}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() =>
          void run("cancel", "cancel the campaign", async () => {
            const res = await api<{ cancelled: number }>(`${base}/campaigns/${c.id}/cancel`, { method: "POST", body: {} });
            setConfirmCancel(false);
            await reload();
            return `Campaign cancelled. ${plural(res.cancelled, "waiting message")} won't be sent.`;
          })
        }
      >
        <p>Messages not yet handed to WhatsApp won&apos;t be sent. Messages already sent can&apos;t be called back.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this campaign?"
        confirmLabel="Delete"
        danger
        busy={busy === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() =>
          void run("delete", "delete the campaign", async () => {
            await api(`${base}/campaigns/${c.id}`, { method: "DELETE" });
            setConfirmDelete(false);
            onDeleted();
            return "Campaign deleted.";
          })
        }
      >
        <p>The draft is deleted. Messages it already sent stay in the message history.</p>
      </ConfirmDialog>
    </div>
  );
}

/** The store's campaigns, writing new ones, and each one's detail. */
export function Campaigns({ base, overview }: { base: string; overview: WaOverview }) {
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get("campaign");
  const edit = params.get("edit");
  const { data, error, loading, reload } = useApi<{ campaigns: WaCampaign[] }>(`${base}/campaigns`);
  const templates = useApi<WaTemplatesAnswer>(`${base}/templates`);
  const go = (extra: Record<string, string>) => router.push(waHref("campaigns", extra));
  const can = overview.can;
  if (error || templates.error)
    return (
      <LoadError
        what="your campaigns"
        error={error ?? templates.error}
        onRetry={() => {
          void reload();
          void templates.reload();
        }}
        busy={loading || templates.loading}
      />
    );
  if (!data || !templates.data) return <Skeleton lines={5} />;
  if (edit && can.manage) {
    const editing = edit === "new" ? null : (data.campaigns.find((c) => c.id === edit) ?? null);
    return (
      <CampaignEditor
        key={edit}
        base={base}
        editing={editing}
        templates={templates.data.templates}
        onCancel={() => go(editing ? { campaign: editing.id } : {})}
        onDone={(id) => {
          void reload();
          go({ campaign: id });
        }}
      />
    );
  }
  if (view)
    return (
      <CampaignView
        key={view}
        base={base}
        id={view}
        overview={overview}
        onBack={() => {
          void reload();
          go({});
        }}
        onEdit={() => go({ edit: view })}
        onDeleted={() => {
          void reload();
          go({});
        }}
      />
    );
  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">Campaigns</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Send an approved marketing template to customers who agreed to WhatsApp marketing, now or at a time you choose. You see the exact number of recipients before anything is sent.
            </p>
          </div>
          {can.manage && (
            <button type="button" className="btn-primary" onClick={() => go({ edit: "new" })}>
              New campaign
            </button>
          )}
        </div>
      </section>
      {!data.campaigns.length ? (
        <EmptyState title="No campaigns yet" body="Customers join your audience when they agree to WhatsApp marketing: by replying START, at checkout (when you say Shopify's text-message consent covers WhatsApp), or when your team records it." />
      ) : (
        <div className="overflow-x-auto card">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 pr-3 font-medium">Campaign</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Recipients</th>
                <th className="py-2 pr-3 font-medium">Delivered</th>
                <th className="py-2 pr-3 font-medium">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.campaigns.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-3">
                    <button type="button" className="text-left font-medium text-accent underline-offset-2 hover:underline" onClick={() => go({ campaign: c.id })}>
                      {c.name}
                    </button>
                    <span className="block text-xs text-muted">{c.status === "scheduled" && c.scheduledAt ? `Starts ${fmtWhen(c.scheduledAt, overview.store.timezone)}` : c.template.name}</span>
                  </td>
                  <td className="py-2 pr-3">
                    <Pill map={CAMPAIGN_STATUS} status={c.status} />
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{c.recipients ? fmtNum(c.recipients) : c.estimatedRecipients ? `~${fmtNum(c.estimatedRecipients)}` : "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{c.progress ? fmtNum(c.progress.delivered) : "—"}</td>
                  <td className="py-2 pr-3 tabular-nums">{c.progress ? fmtNum(c.progress.failed) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
