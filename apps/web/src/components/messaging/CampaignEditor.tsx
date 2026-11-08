"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_ATTRIBUTION_DAYS, smsCampaignSchema, templateVariables } from "@app/shared/sms";
import { useToast } from "@/components/AppUi";
import { Chip, SoftBox, StepCard } from "@/components/automations/MarketingKit";
import { Alert } from "@/components/ui";
import { api, fmtNum } from "@/lib/api";
import { countryName, fmtUsd, smsError, TemplatePicker, useSms } from "./MessagingUi";
import { blankFilter, fromFilter, parseFilter, SegmentFilterFields, type FilterDraft } from "./SegmentFilter";
import type { CampaignEstimate, SmsCampaign, SmsSegment, SmsTemplate } from "./types";

interface Draft {
  name: string;
  templateId: string;
  audience: "segment" | "filter";
  segmentId: string;
  filter: FilterDraft;
  discountCode: string;
  attributionDays: string;
}

const draftOf = (c: SmsCampaign | null): Draft =>
  c
    ? {
        name: c.name,
        templateId: c.templateId,
        audience: c.segmentId ? "segment" : "filter",
        segmentId: c.segmentId ?? "",
        filter: fromFilter(c.filter),
        discountCode: c.discountCode ?? "",
        attributionDays: String(c.attributionDays),
      }
    : { name: "", templateId: "", audience: "filter", segmentId: "", filter: blankFilter(), discountCode: "", attributionDays: String(DEFAULT_ATTRIBUTION_DAYS) };

/** The draft as the API takes it, checked with the shared schema. */
function parseDraft(d: Draft) {
  const f = parseFilter(d.filter);
  if (d.audience === "filter" && !f.ok) return { ok: false as const, problems: f.problems };
  if (d.audience === "segment" && !d.segmentId) return { ok: false as const, problems: ["Segment: choose one, or choose the audience for this campaign."] };
  const r = smsCampaignSchema.safeParse({
    name: d.name,
    templateId: d.templateId,
    segmentId: d.audience === "segment" ? d.segmentId || null : null,
    filter: d.audience === "filter" && f.ok ? f.filter : { countries: [] },
    discountCode: d.discountCode.trim() || null,
    attributionDays: Number(d.attributionDays),
  });
  if (r.success) return { ok: true as const, input: r.data };
  const LABEL: Record<string, string> = { name: "Name", templateId: "Template", segmentId: "Segment", discountCode: "Discount code", attributionDays: "Attribution window" };
  return { ok: false as const, problems: r.error.issues.map((i) => `${LABEL[String(i.path[0])] ?? String(i.path[0])}: ${i.message}`) };
}

/** Who the campaign would reach now and what that is expected to cost (POST campaigns/estimate). */
function Reach({ base, d }: { base: string; d: Draft }) {
  const f = parseFilter(d.filter);
  const ready = !!d.templateId && (d.audience === "segment" ? !!d.segmentId : f.ok);
  const key = ready ? JSON.stringify({ templateId: d.templateId, segmentId: d.audience === "segment" ? d.segmentId : null, filter: d.audience === "filter" && f.ok ? f.filter : { countries: [] } }) : null;
  const [state, setState] = useState<{ key: string; data: CampaignEstimate | null; error: string | null } | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    if (!key) return;
    const request = ++latest.current;
    const t = window.setTimeout(() => {
      api<CampaignEstimate>(`${base}/campaigns/estimate`, { method: "POST", body: JSON.parse(key) })
        .then((data) => request === latest.current && setState({ key, data, error: null }))
        .catch((e) => request === latest.current && setState({ key, data: null, error: smsError(e, "estimate the campaign") }));
    }, 500);
    return () => window.clearTimeout(t);
  }, [base, key]);
  if (!key) return <p className="text-sm text-muted">Choose a template and an audience to see who it would reach and what it would cost.</p>;
  const fresh = state && state.key === key ? state : null;
  if (!fresh) return <div className="skeleton h-24" aria-label="Estimating" />;
  if (fresh.error) return <p className="text-sm text-danger">{fresh.error}</p>;
  const e = fresh.data!;
  return (
    <div className="space-y-2 text-sm" aria-live="polite">
      <p>
        <strong className="text-lg tabular-nums">{fmtNum(e.recipients)}</strong> customer{e.recipients === 1 ? "" : "s"} would get it right now, {e.partsPerText} part{e.partsPerText === 1 ? "" : "s"} each.
      </p>
      {e.byCountry.length > 0 && <p className="text-xs text-muted">{e.byCountry.map((c) => `${countryName(c.country)} ${fmtNum(c.count)}`).join(" · ")}</p>}
      <p>
        Expected cost: <strong>{e.recipients - e.unpricedRecipients > 0 ? fmtUsd(e.estimatedCostUsd) : "—"}</strong>
        {e.unpricedRecipients > 0 && (
          <span className="text-muted">
            {" "}
            {e.recipients - e.unpricedRecipients > 0 ? "plus" : "for"} {fmtNum(e.unpricedRecipients)} customer{e.unpricedRecipients === 1 ? "" : "s"} in countries the SMS provider hasn&apos;t priced for you yet (no estimate).
          </span>
        )}
      </p>
      {e.recipients > e.max && <p className="text-danger">A campaign can reach at most {fmtNum(e.max)} customers. Narrow the audience.</p>}
      <p className="text-xs text-muted">The exact number is counted again, and confirmed by you, when you schedule it. Only customers subscribed to SMS marketing who haven&apos;t opted out are counted.</p>
    </div>
  );
}

/**
 * Write a campaign (a draft): its name, marketing template, audience and discount code, in the
 * numbered steps the Stitch design's screen 15 draws (name and message, who, reach and cost,
 * approval). SMS only: WhatsApp campaigns are written on the WhatsApp pages.
 */
export function CampaignEditor({ campaign, templates, segments, onDone }: { campaign: SmsCampaign | null; templates: SmsTemplate[]; segments: SmsSegment[]; onDone: (saved: boolean) => void }) {
  const { base, store } = useSms();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(campaign));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  // It opens under the list (the design's order), so it is brought into view.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  if (!base) return null;
  const options = templates.filter((t) => t.category === "marketing" && t.status !== "archived");
  const chosen = options.find((t) => t.id === d.templateId);
  const needsCode = templateVariables(chosen?.approvedBody ?? chosen?.body ?? "").used.includes("discount_code");
  const parsed = parseDraft(d);
  const save = async () => {
    setTried(true);
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      await api(campaign ? `${base}/campaigns/${campaign.id}` : `${base}/campaigns`, { method: campaign ? "PUT" : "POST", body: parsed.input });
      toast("success", "Saved as a draft. Submit it for approval when it's ready.");
      onDone(true);
    } catch (e) {
      setError(smsError(e, "save the campaign"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section ref={ref} className="scroll-mt-20 space-y-4" aria-labelledby="cmp-ed-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="cmp-ed-h" className="home-h2 flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 rounded-full bg-accent" />
          {campaign ? `Edit “${campaign.name}”` : "New campaign"}
        </h2>
        <p className="text-[11px] font-semibold tracking-wider text-muted uppercase">Draft in progress</p>
      </div>
      {error && <Alert>{error}</Alert>}
      <StepCard id="cmp-step-message" n={1} level={3} title="Name and message">
        <div className="max-w-xl space-y-4">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Channel:</span> <Chip tone="accent">SMS</Chip>
            <span className="text-xs text-muted">Email campaigns: not available yet</span>
          </p>
          <div>
            <label className="label" htmlFor="cmp-name">
              Name
            </label>
            <input id="cmp-name" className="input" maxLength={80} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Spring sale" />
          </div>
          <TemplatePicker
            label="Marketing template"
            templates={options}
            value={d.templateId}
            onChange={(templateId) => setD({ ...d, templateId })}
            empty={
              <>
                No marketing template yet. Write one (with the opt-out link) in{" "}
                <Link className="text-accent underline" href="/messaging/templates">
                  Message Templates
                </Link>
                .
              </>
            }
            help={chosen && chosen.approvedVersion === null ? "This template isn't approved yet: it must be before the campaign can be submitted." : "Campaigns send the template's approved version."}
          />
          {needsCode && (
            <div className="max-w-xs">
              <label className="label" htmlFor="cmp-code">
                Discount code
              </label>
              <input id="cmp-code" className="input font-mono uppercase" maxLength={30} value={d.discountCode} onChange={(e) => setD({ ...d, discountCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
              <p className="mt-1 text-xs text-muted">Create it in Shopify first: the text shows it as typed here.</p>
            </div>
          )}
        </div>
      </StepCard>
      <StepCard id="cmp-step-who" n={2} level={3} title="Who">
          <fieldset className="min-w-0 space-y-3">
            <legend className="sr-only">Audience</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="cmp-audience" className="accent-[var(--accent)]" checked={d.audience === "filter"} onChange={() => setD({ ...d, audience: "filter" })} />
                Choose for this campaign
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="cmp-audience" className="accent-[var(--accent)]" checked={d.audience === "segment"} onChange={() => setD({ ...d, audience: "segment" })} disabled={!segments.length} />
                A saved segment{segments.length ? "" : " (none yet)"}
              </label>
            </div>
            {d.audience === "segment" ? (
              <div>
                <label className="label" htmlFor="cmp-seg">
                  Segment
                </label>
                <select id="cmp-seg" className="input" value={d.segmentId} onChange={(e) => setD({ ...d, segmentId: e.target.value })}>
                  <option value="">Choose a segment…</option>
                  {segments.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({fmtNum(s.recipients)})
                    </option>
                  ))}
                </select>
                {d.segmentId && <p className="mt-1 text-xs text-muted">{segments.find((s) => s.id === d.segmentId)?.description}</p>}
              </div>
            ) : (
              <SegmentFilterFields value={d.filter} onChange={(filter) => setD({ ...d, filter })} currency={store?.currency} />
            )}
          </fieldset>
      </StepCard>
      <StepCard id="cmp-step-reach" n={3} level={3} title="Reach and cost">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <SoftBox>
            <Reach base={base} d={d} />
          </SoftBox>
          <div>
            <label className="label" htmlFor="cmp-attr">
              Attribution window (days)
            </label>
            <input id="cmp-attr" className="input" type="number" min={1} max={14} value={d.attributionDays} onChange={(e) => setD({ ...d, attributionDays: e.target.value })} />
            <p className="mt-1 text-xs text-muted">An order within this many days after the text counts as following it (not as caused by it).</p>
          </div>
        </div>
      </StepCard>
      <StepCard id="cmp-step-approval" n={4} level={3} title="Approval">
        <SoftBox>Saving keeps it as a draft. Submitted, an owner or admin approves it; then it is scheduled, typing the exact number of customers to confirm. Nothing goes out before.</SoftBox>
        {tried && !parsed.ok && (
          <Alert>
            <ul className="list-disc space-y-0.5 pl-4">
              {parsed.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onDone(false)}>
            Cancel
          </button>
        </div>
      </StepCard>
    </section>
  );
}
