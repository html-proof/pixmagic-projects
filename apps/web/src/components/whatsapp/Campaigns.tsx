"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { describeWaAudience, renderWaText, WA_CAMPAIGN_MAX, type WaAudience } from "@app/shared/whatsapp";
import { ConfirmDialog, Dialog, Skeleton } from "@/components/AppUi";
import { ROW, SoftBox, StepCard, TableCard, TableHead, TD, Th } from "./MarketingKit";
import { Badge } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { Alert, EmptyState } from "@/components/ui";
import { api, ApiError, fmtNum, useApi } from "@/lib/api";
import { CountryPicker, fmtWhen, plural } from "./ListUi";
import type { WaCampaign, WaOverview, WaTemplate, WaTemplatesResponse } from "./types";
import { CAMPAIGN_STATUS, useWaAction, WaBubble, waError, waHref } from "./WaUi";

// ---------------------------------------------------------------------------
// Campaigns (docs/whatsapp.md, "Campaigns"): a marketing template to the customers who agreed to
// marketing messages. A campaign is saved as a draft, and launched only from its own dialog, which
// shows the exact number of recipients and asks the merchant to confirm it; opening this tab never
// sends anything. Results are counted by the API from the campaign's messages. Laid out as the
// Stitch design's Campaigns screen (15): the campaigns as a table first, then the editor in numbered
// parts. WhatsApp reports read; it reports no orders that followed and no cost, so they aren't here.
// ---------------------------------------------------------------------------

interface AudienceDraft {
  countries: string[];
  customerType: "any" | "new" | "returning";
  orderedWithinDays: string;
  notOrderedForDays: string;
  minOrders: string;
  minSpent: string;
}

const blankAudience = (): AudienceDraft => ({ countries: [], customerType: "any", orderedWithinDays: "", notOrderedForDays: "", minOrders: "", minSpent: "" });

const audienceDraftOf = (a: WaAudience): AudienceDraft => ({
  countries: a.countries ?? [],
  customerType: a.customerType ?? "any",
  orderedWithinDays: a.orderedWithinDays != null ? String(a.orderedWithinDays) : "",
  notOrderedForDays: a.notOrderedForDays != null ? String(a.notOrderedForDays) : "",
  minOrders: a.minOrders != null ? String(a.minOrders) : "",
  minSpent: a.minSpent != null ? String(a.minSpent) : "",
});

const num = (s: string) => (s.trim() === "" ? null : Number(s));

/** The audience as the API takes it (waAudienceSchema). */
function audienceOf(d: AudienceDraft): WaAudience {
  return {
    countries: d.countries,
    customerType: d.customerType,
    orderedWithinDays: num(d.orderedWithinDays),
    notOrderedForDays: num(d.notOrderedForDays),
    minOrders: num(d.minOrders),
    minSpent: num(d.minSpent),
  };
}

/** What's wrong with the audience's numbers, in words. */
function audienceProblems(d: AudienceDraft): string[] {
  const out: string[] = [];
  const whole = (s: string, label: string, max: number) => {
    if (s.trim() === "") return;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > max) out.push(`${label}: a whole number from 1 to ${max}.`);
  };
  whole(d.orderedWithinDays, "Ordered in the last … days", 3650);
  whole(d.notOrderedForDays, "Haven't ordered for … days", 3650);
  whole(d.minOrders, "At least … orders", 100_000);
  if (d.minSpent.trim() !== "" && !(Number(d.minSpent) >= 0)) out.push("Spent at least: an amount of 0 or more.");
  return out;
}

export function Campaigns({ base, overview }: { base: string; overview: WaOverview }) {
  const list = useApi<{ campaigns: WaCampaign[] }>(`${base}/campaigns`);
  const templates = useApi<WaTemplatesResponse>(`${base}/templates`);
  const [editing, setEditing] = useState<WaCampaign | "new" | null>(null);
  const [launching, setLaunching] = useState<WaCampaign | null>(null);
  const [cancelling, setCancelling] = useState<WaCampaign | null>(null);
  const [deleting, setDeleting] = useState<WaCampaign | null>(null);
  const { busy, run } = useWaAction();
  const manage = overview.can.manage;
  const provider = overview.connection?.provider ?? "qr";
  const cap = WA_CAMPAIGN_MAX[provider];
  const tz = overview.store.timezone;

  if (list.error && !list.data) return <LoadError what="campaigns" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />;
  if (!list.data || !templates.data) return <Skeleton lines={5} />;
  const marketing = templates.data.templates.filter((t) => t.category === "marketing");

  if (editing) {
    return (
      <Editor
        base={base}
        campaign={editing === "new" ? null : editing}
        templates={marketing}
        samples={templates.data.samples as Record<string, string>}
        cap={cap}
        qr={provider === "qr"}
        onDone={(saved) => {
          setEditing(null);
          void list.reload();
          if (saved) setLaunching(saved);
        }}
      />
    );
  }

  const campaigns = list.data.campaigns;
  /** A campaign's buttons, the same on a phone's stacked row and the table's last column. */
  const actions = (c: WaCampaign) =>
    manage ? (
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {c.status === "draft" && (
          <>
            <button type="button" className="btn-primary h-8 px-3 text-xs" onClick={() => setLaunching(c)}>
              Launch…
            </button>
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setEditing(c)}>
              Edit
            </button>
          </>
        )}
        {(c.status === "scheduled" || c.status === "sending") && (
          <button type="button" className="btn-danger h-8 px-3 text-xs" onClick={() => setCancelling(c)}>
            Cancel campaign
          </button>
        )}
        {(c.status === "draft" || c.status === "completed" || c.status === "cancelled") && (
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setDeleting(c)}>
            Delete
          </button>
        )}
        {c.status !== "draft" && (
          <Link className="btn-secondary h-8 px-3 text-xs" href={waHref("messages", { campaign: c.id })}>
            Messages
          </Link>
        )}
      </div>
    ) : null;
  /** When it ran (or is to run), as each date the API keeps for it. */
  const dates = (c: WaCampaign) => (
    <>
      {c.status === "scheduled" && c.scheduledAt && <span className="block">starts {fmtWhen(c.scheduledAt, tz)}</span>}
      {c.startedAt && <span className="block">started {fmtWhen(c.startedAt, tz)}</span>}
      {c.completedAt && <span className="block">finished {fmtWhen(c.completedAt, tz)}</span>}
      {c.cancelledAt && <span className="block">cancelled {fmtWhen(c.cancelledAt, tz)}</span>}
      {!c.scheduledAt && !c.startedAt && !c.completedAt && !c.cancelledAt && <span className="block text-muted">–</span>}
    </>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Send a marketing message to customers who agreed to marketing messages. Customers who opted out, are on your do-not-message list, or aren&apos;t on WhatsApp are always left out.
          Each campaign sends to at most {fmtNum(cap)} people on this connection.
        </p>
        {manage && (
          <button type="button" className="btn-primary shrink-0" onClick={() => setEditing("new")}>
            <Plus aria-hidden className="h-4 w-4" /> New campaign
          </button>
        )}
      </div>
      {provider === "qr" && <QrWarning />}
      {!overview.settings.marketingEnabled && (
        <Alert kind="info">
          Marketing messages are switched off in{" "}
          <Link className="underline" href={waHref("settings")}>
            Settings
          </Link>
          : campaigns can be written but not launched until they&apos;re on.
        </Alert>
      )}

      {campaigns.length === 0 ? (
        <EmptyState title="No campaigns yet" body="Write a marketing template first, then create a campaign, choose who it goes to, and launch it when you're ready." />
      ) : (
        <TableCard id="wa-campaigns" title="Campaigns" testId="wa-campaigns">
          {/* Phones: each campaign as a stacked row. */}
          <ul className="divide-y divide-home-line border-t border-home-line sm:hidden" aria-label="Campaigns">
            {campaigns.map((c) => {
              const st = CAMPAIGN_STATUS[c.status] ?? { tone: "neutral" as const, label: c.status };
              const tpl = templates.data!.templates.find((t) => t.id === c.templateId);
              return (
                <li key={c.id} className="space-y-2 px-5 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  <p className="text-muted">{c.audienceLabel}</p>
                  <p className="text-xs text-muted">
                    Template: {tpl?.name ?? "deleted"}
                    {c.status === "scheduled" && c.scheduledAt ? ` · starts ${fmtWhen(c.scheduledAt, tz)}` : ""}
                    {c.startedAt ? ` · started ${fmtWhen(c.startedAt, tz)}` : ""}
                    {c.completedAt ? ` · finished ${fmtWhen(c.completedAt, tz)}` : ""}
                    {c.cancelledAt ? ` · cancelled ${fmtWhen(c.cancelledAt, tz)}` : ""}
                  </p>
                  {c.confirmedRecipients != null && <p className="text-xs text-muted">{plural(c.confirmedRecipients, "recipient")} confirmed at launch · {plural(c.recipients, "message")} made so far</p>}
                  {c.report && c.report.total > 0 && <Report report={c.report} />}
                  {actions(c)}
                </li>
              );
            })}
          </ul>
          <table className="hidden w-full min-w-[56rem] text-sm sm:table" aria-label="Campaigns">
            <TableHead>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Date</Th>
              <Th right>Waiting</Th>
              <Th right>Sent</Th>
              <Th right>Delivered</Th>
              <Th right>Read</Th>
              <Th right>Failed</Th>
              <Th right>Not sent</Th>
              <Th right>
                <span className="sr-only">Actions</span>
              </Th>
            </TableHead>
            <tbody>
              {campaigns.map((c) => {
                const st = CAMPAIGN_STATUS[c.status] ?? { tone: "neutral" as const, label: c.status };
                const tpl = templates.data!.templates.find((t) => t.id === c.templateId);
                const r = c.report && c.report.total > 0 ? c.report : null;
                const n = (v: number | undefined): ReactNode => (r && v !== undefined ? fmtNum(v) : <span className="text-muted">–</span>);
                return (
                  <tr key={c.id} className={ROW}>
                    <td className={`${TD} max-w-[16rem]`}>
                      <p className="font-medium">{c.name}</p>
                      <p className="text-xs text-muted">{c.audienceLabel}</p>
                      <p className="text-xs text-muted">Template: {tpl?.name ?? "deleted"}</p>
                      {c.confirmedRecipients != null && (
                        <p className="text-xs text-muted">
                          {plural(c.confirmedRecipients, "recipient")} confirmed at launch · {plural(c.recipients, "message")} made so far
                        </p>
                      )}
                    </td>
                    <td className={TD}>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className={`${TD} text-xs whitespace-nowrap`}>{dates(c)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.waiting)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.sent)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.delivered)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.read)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.failed)}</td>
                    <td className={`${TD} text-right tabular-nums`}>{n(r?.notSent)}</td>
                    <td className={TD}>{actions(c)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableCard>
      )}

      {launching && (
        <LaunchDialog
          base={base}
          campaign={launching}
          template={templates.data.templates.find((t) => t.id === launching.templateId) ?? null}
          cap={cap}
          qr={provider === "qr"}
          tz={tz}
          onClose={(launched) => {
            setLaunching(null);
            if (launched) void list.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={!!cancelling}
        title={`Cancel "${cancelling?.name ?? ""}"?`}
        confirmLabel="Cancel campaign"
        danger
        busy={busy === "cancel"}
        onCancel={() => setCancelling(null)}
        onConfirm={() =>
          void run("cancel", "cancel the campaign", async () => {
            const r = await api<{ cancelled: number }>(`${base}/campaigns/${cancelling!.id}/cancel`, { method: "POST" });
            setCancelling(null);
            void list.reload();
            return `Campaign cancelled. ${plural(r.cancelled, "waiting message")} won't be sent.`;
          })
        }
      >
        <p>Messages still waiting are cancelled. Messages already sent can&apos;t be taken back.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete campaign"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void run("delete", "delete the campaign", async () => {
            await api(`${base}/campaigns/${deleting!.id}`, { method: "DELETE" });
            setDeleting(null);
            void list.reload();
            return "Campaign deleted.";
          })
        }
      >
        <p>The campaign goes from this list. Its messages stay in Message history.</p>
      </ConfirmDialog>
    </div>
  );
}

function QrWarning() {
  return (
    <Alert kind="info">
      This store sends from a phone linked with a QR code, not Meta&apos;s official API. WhatsApp may restrict or ban a number it sees sending bulk or unwanted messages, so send campaigns only to
      customers who asked for them. bizinsights paces them (a message every few seconds) and caps how many go out a day.
    </Alert>
  );
}

function Report({ report }: { report: NonNullable<WaCampaign["report"]> }) {
  const cells: Array<[string, number]> = [
    ["Waiting", report.waiting],
    ["Sent", report.sent],
    ["Delivered", report.delivered],
    ["Read", report.read],
    ["Failed", report.failed],
    ["Not sent", report.notSent],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2">
      {cells.map(([label, n]) => (
        <div key={label} className="rounded bg-home-soft px-2 py-1">
          <dt className="text-[11px] text-muted">{label}</dt>
          <dd className="text-sm font-semibold">{fmtNum(n)}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * How many customers the audience reaches now with this template (POST campaigns/estimate), asked
 * again as either changes. A template that greets customers by name leaves out those without one.
 */
function useEstimate(base: string, audience: WaAudience | null, templateId: string | null) {
  const key = audience ? JSON.stringify({ audience, templateId: templateId || null }) : null;
  const [state, setState] = useState<{ key: string; count: number | null; error: string | null } | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (!key) return;
    const request = ++latest.current;
    const t = window.setTimeout(() => {
      api<{ count: number }>(`${base}/campaigns/estimate`, { method: "POST", body: JSON.parse(key) })
        .then((r) => {
          if (request === latest.current) setState({ key, count: r.count, error: null });
        })
        .catch((e: unknown) => {
          if (request === latest.current) setState({ key, count: null, error: waError(e, "count the audience") });
        });
    }, 600);
    return () => window.clearTimeout(t);
  }, [base, key]);
  return state && state.key === key ? state : null;
}

// ---------------------------------------------------------------------------
// The editor (a draft)
// ---------------------------------------------------------------------------

function Editor({
  base,
  campaign,
  templates,
  samples,
  cap,
  qr,
  onDone,
}: {
  base: string;
  campaign: WaCampaign | null;
  templates: WaTemplate[];
  samples: Record<string, string>;
  cap: number;
  qr: boolean;
  onDone: (saved: WaCampaign | null) => void;
}) {
  const [name, setName] = useState(campaign?.name ?? "");
  const [templateId, setTemplateId] = useState(campaign?.templateId ?? "");
  const [a, setA] = useState<AudienceDraft>(campaign ? audienceDraftOf(campaign.audience) : blankAudience());
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useWaAction();
  const problems = audienceProblems(a);
  const audience = problems.length ? null : audienceOf(a);
  const estimate = useEstimate(base, audience, templateId);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const unsupported = template ? template.variables.filter((v) => v !== "customer_first_name" && v !== "store_name") : [];
  const set = (patch: Partial<AudienceDraft>) => setA((x) => ({ ...x, ...patch }));
  const ready = !!name.trim() && !!templateId && !problems.length && !unsupported.length;

  const save = (thenLaunch: boolean) =>
    run("save", "save the campaign", async () => {
      setError(null);
      try {
        const body = { name: name.trim(), templateId, audience: audienceOf(a) };
        const r = campaign
          ? await api<{ campaign: WaCampaign }>(`${base}/campaigns/${campaign.id}`, { method: "PUT", body })
          : await api<{ campaign: WaCampaign }>(`${base}/campaigns`, { method: "POST", body });
        onDone(thenLaunch ? r.campaign : null);
        return thenLaunch ? undefined : "Campaign saved as a draft. Nothing has been sent.";
      } catch (e) {
        setError(waError(e, "save the campaign"));
        throw e;
      }
    });

  return (
    <div className="space-y-4">
      <section aria-labelledby="wa-camp-ed-h" className="home-card animate-rise space-y-3 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="wa-camp-ed-h" className="home-h2 flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-accent" />
              {campaign ? `Edit "${campaign.name}"` : "New campaign"}
            </h2>
          </div>
          <button type="button" className="btn-secondary" onClick={() => onDone(null)}>
            Back to campaigns
          </button>
        </div>
        {qr && <QrWarning />}
      </section>

      <StepCard id="wa-camp-step-name" n={1} title="Name" level={3}>
        <div className="sm:max-w-md">
          <label className="label" htmlFor="wa-camp-name">
            Name
          </label>
          <input id="wa-camp-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Winter sale" />
        </div>
      </StepCard>

      <StepCard id="wa-camp-step-message" n={2} title="Message" level={3}>
        <div>
          <label className="label" htmlFor="wa-camp-template">
            Marketing template
          </label>
          <select id="wa-camp-template" className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Choose a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id} disabled={!t.usable}>
                {t.name}
                {t.usable ? "" : ` — ${t.unusableReason ?? "can't be used"}`}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">
            Only marketing templates: they tell customers how to stop (Reply STOP), and campaigns go only to customers who agreed to marketing. Campaigns can fill {"{{customer_first_name}}"} and{" "}
            {"{{store_name}}"}.{" "}
            <Link className="underline" href={waHref("templates")}>
              Write a template
            </Link>
            .
          </p>
          {templates.length === 0 && <p className="mt-1 text-xs text-warn">This store has no marketing template yet.</p>}
          {template && (
            <div className="mt-3 space-y-2">
              <SoftBox className="p-4">
                <WaBubble>{renderWaText(template.body, samples, { lenient: true })}</WaBubble>
              </SoftBox>
              {unsupported.length > 0 && <Alert kind="error">This template uses {unsupported.map((v) => `{{${v}}}`).join(", ")}, which a campaign can&apos;t fill. Pick another.</Alert>}
            </div>
          )}
        </div>
      </StepCard>

      <StepCard id="wa-camp-step-who" n={3} title="Who" level={3}>
        <fieldset className="min-w-0 space-y-3">
          <legend className="label">Who it goes to</legend>
          <p className="text-xs text-muted">Always only customers who agreed to marketing messages; these narrow it further.</p>
          <CountryPicker label="Countries (none: every country)" value={a.countries} onChange={(countries) => set({ countries })} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="wa-camp-type">
                Customers
              </label>
              <select id="wa-camp-type" className="input" value={a.customerType} onChange={(e) => set({ customerType: e.target.value as AudienceDraft["customerType"] })}>
                <option value="any">Everyone</option>
                <option value="new">With one order</option>
                <option value="returning">With more than one order</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="wa-camp-min-orders">
                At least … orders
              </label>
              <input id="wa-camp-min-orders" className="input" inputMode="numeric" value={a.minOrders} onChange={(e) => set({ minOrders: e.target.value.replace(/[^\d]/g, "") })} />
            </div>
            <div>
              <label className="label" htmlFor="wa-camp-within">
                Ordered in the last … days
              </label>
              <input id="wa-camp-within" className="input" inputMode="numeric" value={a.orderedWithinDays} onChange={(e) => set({ orderedWithinDays: e.target.value.replace(/[^\d]/g, "") })} />
            </div>
            <div>
              <label className="label" htmlFor="wa-camp-not-for">
                Haven&apos;t ordered for … days
              </label>
              <input id="wa-camp-not-for" className="input" inputMode="numeric" value={a.notOrderedForDays} onChange={(e) => set({ notOrderedForDays: e.target.value.replace(/[^\d]/g, "") })} />
            </div>
            <div>
              <label className="label" htmlFor="wa-camp-spent">
                Spent at least
              </label>
              <input id="wa-camp-spent" className="input" inputMode="decimal" value={a.minSpent} onChange={(e) => set({ minSpent: e.target.value.replace(/[^\d.]/g, "") })} />
            </div>
          </div>
          {problems.length > 0 && (
            <Alert kind="error">
              <ul className="list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Alert>
          )}
          <div className="rounded bg-home-soft px-4 py-3 text-sm" aria-live="polite">
            {!audience ? (
              <span className="text-muted">Fix the audience to see how many customers it reaches.</span>
            ) : !estimate ? (
              <span className="text-muted">Counting…</span>
            ) : estimate.error ? (
              <span className="text-danger">{estimate.error}</span>
            ) : (
              <>
                <span className="font-semibold">{plural(estimate.count ?? 0, "customer")}</span> can receive it now. <span className="text-muted">{describeWaAudience(audience)}.</span>
                {template?.variables.includes("customer_first_name") && <span className="text-muted"> Customers whose first name bizinsights doesn&apos;t have are left out: the template greets them by name.</span>}
                {(estimate.count ?? 0) > cap && <span className="mt-1 block text-danger">That&apos;s more than the {fmtNum(cap)} one campaign can send to on this connection: narrow the audience.</span>}
              </>
            )}
          </div>
        </fieldset>
      </StepCard>

      {/* The launch is its own step, as the design's last part asks for approval: the exact count, confirmed in the launch dialog. */}
      <StepCard id="wa-camp-step-launch" n={4} title="Launch" level={3}>
        <p className="text-sm text-muted">Saving keeps it as a draft. Nothing is sent until you launch it and confirm the number of recipients.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" disabled={!ready || !!busy} onClick={() => void save(false)}>
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="btn-primary" disabled={!ready || !!busy} onClick={() => void save(true)}>
            Save and review launch…
          </button>
        </div>
      </StepCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launching: the exact count, confirmed
// ---------------------------------------------------------------------------

function LaunchDialog({
  base,
  campaign,
  template,
  cap,
  qr,
  tz,
  onClose,
}: {
  base: string;
  campaign: WaCampaign;
  template: WaTemplate | null;
  cap: number;
  qr: boolean;
  tz: string;
  onClose: (launched: boolean) => void;
}) {
  const estimate = useEstimate(base, campaign.audience, campaign.templateId);
  const [count, setCount] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, run } = useWaAction();
  // The count shown is the latest the API gave: the estimate first, then a launch's refusal.
  const shown = count ?? estimate?.count ?? null;
  const scheduledAt = when === "later" && at ? new Date(at) : null;
  const badTime = when === "later" && (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 60_000);
  const tooMany = shown !== null && shown > cap;
  const canLaunch = shown !== null && shown > 0 && !tooMany && confirmed && !badTime && !busy;

  const launch = () =>
    run("launch", "launch the campaign", async () => {
      setError(null);
      setProblems([]);
      try {
        await api(`${base}/campaigns/${campaign.id}/launch`, { method: "POST", body: { confirmRecipients: shown, scheduledAt: scheduledAt ? scheduledAt.toISOString() : null } });
      } catch (e) {
        if (e instanceof ApiError && e.code === "count_changed") {
          const next = (e.data.detail as { count?: unknown } | undefined)?.count;
          if (typeof next === "number") setCount(next);
          setConfirmed(false);
        }
        const detail = e instanceof ApiError ? (e.data.detail as { problems?: unknown } | undefined) : undefined;
        if (Array.isArray(detail?.problems)) setProblems(detail.problems.filter((p): p is string => typeof p === "string"));
        setError(waError(e, "launch the campaign"));
        throw e;
      }
      onClose(true);
      return scheduledAt ? `Scheduled for ${fmtWhen(scheduledAt.toISOString(), tz)}.` : "Launched. Messages go out a few seconds apart; follow them here and in Message history.";
    });

  return (
    <Dialog open title={`Launch "${campaign.name}"`} onClose={() => onClose(false)}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">{campaign.audienceLabel}.</p>
        {template && <WaBubble>{template.body}</WaBubble>}
        <div className="rounded bg-home-soft p-3" aria-live="polite">
          {shown === null ? (
            estimate?.error ? <span className="text-danger">{estimate.error}</span> : <span className="text-muted">Counting recipients…</span>
          ) : (
            <>
              <span className="text-base font-semibold">{plural(shown, "customer")}</span> will receive it.
              {count !== null && <span className="mt-1 block text-warn">The audience changed since you last looked: this is the new count.</span>}
              {shown === 0 && <span className="mt-1 block text-muted">Nobody in this audience can receive marketing messages right now.</span>}
              {tooMany && <span className="mt-1 block text-danger">More than the {fmtNum(cap)} one campaign may send to on this connection. Edit the audience to narrow it.</span>}
            </>
          )}
        </div>
        {qr && (
          <Alert kind="info">
            Sent from your linked phone, a message every few seconds, within your sending hours and daily limit. WhatsApp may restrict a number that sends unwanted bulk messages.
          </Alert>
        )}
        <fieldset className="space-y-2">
          <legend className="label">When</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="when" className="accent-[var(--accent)]" checked={when === "now"} onChange={() => setWhen("now")} />
            Now
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="when" className="accent-[var(--accent)]" checked={when === "later"} onChange={() => setWhen("later")} />
            Later
          </label>
          {when === "later" && (
            <div>
              <label className="sr-only" htmlFor="wa-camp-at">
                Date and time
              </label>
              <input id="wa-camp-at" type="datetime-local" className="input max-w-xs" value={at} onChange={(e) => setAt(e.target.value)} />
              <p className="mt-1 text-xs text-muted">In your browser&apos;s time zone. Messages still keep to the store&apos;s sending hours ({tz}).</p>
              {badTime && at && <p className="mt-1 text-xs text-danger">Pick a time at least a minute from now.</p>}
            </div>
          )}
        </fieldset>
        {shown !== null && shown > 0 && !tooMany && (
          <label className="flex items-start gap-2 rounded border border-home-line p-3">
            <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>
              Send this marketing message to <span className="font-semibold">{plural(shown, "customer")}</span>. They all agreed to marketing messages, and every message tells them how to stop.
            </span>
          </label>
        )}
        {error && (
          <Alert kind="error">
            {error}
            {problems.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn-secondary" onClick={() => onClose(false)} disabled={!!busy}>
            Not now
          </button>
          <button type="button" className="btn-primary" disabled={!canLaunch} onClick={() => void launch()}>
            {busy === "launch" ? "Launching…" : when === "later" ? "Schedule campaign" : shown ? `Send to ${plural(shown, "customer")}` : "Send"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
