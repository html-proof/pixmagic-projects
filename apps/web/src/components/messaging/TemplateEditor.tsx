"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CATEGORY_LABEL,
  checkTemplate,
  hasErrors,
  previewSms,
  SMS_CATEGORIES,
  SMS_MAX_BODY,
  SMS_VARIABLE_INFO,
  SMS_VARIABLES,
  smsSegments,
  templateCan,
  toGsmFriendly,
  worstCaseSegments,
  type SmsCategory,
  type SmsVariable,
  type TemplateAction,
  type TemplateIssue,
} from "@app/shared/sms";
import { ConfirmDialog, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { actionLabel, countryName, CountryPicker, fmtUsd, fmtWhen, smsError, StatusPill, TEMPLATE_STATUS, TextBubble, useSms, useSmsAction, whoLabel } from "./MessagingUi";
import type { SmsTemplate, TemplateDetail, TemplatePreview } from "./types";

interface Draft {
  name: string;
  category: SmsCategory;
  body: string;
  countries: string[];
  dltTemplateId: string;
  dltText: string;
}

const blank = (): Draft => ({ name: "", category: "transactional", body: "", countries: [], dltTemplateId: "", dltText: "" });

const fromDetail = (d: TemplateDetail): Draft => {
  const latest = d.versions[0];
  return {
    name: d.template.name,
    category: latest?.category ?? d.template.category,
    body: latest?.body ?? d.template.body ?? "",
    countries: d.template.countries,
    dltTemplateId: latest?.dltTemplateId ?? "",
    dltText: latest?.dltText ?? "",
  };
};

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function Issues({ issues }: { issues: TemplateIssue[] }) {
  if (!issues.length) return <p className="text-sm text-good">No problems found.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {issues.map((i) => (
        <li key={i.code + i.message} className={i.level === "error" ? "text-danger" : "text-warn"}>
          <span className="font-medium">{i.level === "error" ? "Fix: " : "Note: "}</span>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

/** What a template costs to send to each chosen country: AWS's own prices, or "no price yet". Never a guess. */
function Prices({ base, draft }: { base: string; draft: Draft }) {
  const [state, setState] = useState<{ key: string; data: TemplatePreview | null; error: string | null } | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify([draft.category, draft.body, draft.countries, draft.dltTemplateId, draft.dltText]);
  const ready = draft.countries.length > 0 && draft.body.trim().length > 0;
  useEffect(() => {
    if (!ready) return;
    const request = ++latest.current;
    const t = window.setTimeout(() => {
      api<TemplatePreview>(`${base}/templates/preview`, {
        method: "POST",
        body: { category: draft.category, body: draft.body, countries: draft.countries, dltTemplateId: draft.dltTemplateId || null, dltText: draft.dltText || null },
      })
        .then((data) => request === latest.current && setState({ key, data, error: null }))
        .catch((e) => request === latest.current && setState({ key, data: null, error: smsError(e, "estimate the cost") }));
    }, 600);
    return () => window.clearTimeout(t);
    // The key holds every field the estimate depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, key, ready]);
  if (!ready) return <p className="text-sm text-muted">Choose the countries this template goes to, to see what each text is expected to cost there.</p>;
  if (!state || state.key !== key) return <div className="skeleton h-16" aria-label="Estimating" />;
  if (state.error) return <p className="text-sm text-danger">{state.error}</p>;
  const p = state.data!;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 pr-3 text-left font-medium">Country</th>
            <th className="py-1 pr-3 text-right font-medium">Per part</th>
            <th className="py-1 pr-3 text-right font-medium">This text ({p.segments.segments} part{p.segments.segments === 1 ? "" : "s"})</th>
            <th className="py-1 text-right font-medium">At most ({p.worst.segments})</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {p.prices.map((r) => (
            <tr key={r.country}>
              <td className="py-1.5 pr-3">{countryName(r.country)}</td>
              {r.perPartUsd === null ? (
                <td className="py-1.5 text-xs text-muted" colSpan={3}>
                  No price yet: AWS reports the price with each delivery.
                </td>
              ) : (
                <>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {fmtUsd(r.perPartUsd)}
                    <span className="block text-[11px] text-muted">{r.source === "aws_billed" ? "what AWS billed you" : "AWS price list"}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtUsd(r.estimateUsd)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(r.worstUsd)}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted">Estimates in US dollars. AWS charges per part and reports the real price with each delivery; carriers in some countries add a fee.</p>
    </div>
  );
}

/** Write or edit a template, see how it splits into parts and what it costs, and move it through review. */
export function TemplateEditor({ id: initialId, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const { base, manage, meId, store } = useSms();
  const toast = useToast();
  const { busy, run } = useSmsAction();
  const [id, setId] = useState(initialId);
  const detail = useApi<TemplateDetail>(base && id ? `${base}/templates/${id}` : null);
  const [draft, setDraft] = useState<Draft>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [archiving, setArchiving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  // What the server holds is the draft, whenever it (re)loads.
  useEffect(() => {
    if (detail.data) setDraft(fromDetail(detail.data));
  }, [detail.data]);

  if (!base) return null;
  if (id && detail.error) return <LoadError what="the template" error={detail.error} onRetry={() => void detail.reload()} busy={detail.loading} />;
  if (id && !detail.data) return <Skeleton lines={6} />;

  const t: SmsTemplate | null = detail.data?.template ?? null;
  const archived = t?.status === "archived";
  const editable = manage && !archived;
  const saved = detail.data ? fromDetail(detail.data) : blank();
  const dirty = !same(draft, saved);
  const forIndia = draft.countries.includes("IN");
  const text = previewSms(draft.body);
  const now = smsSegments(text);
  const worst = worstCaseSegments(draft.body);
  const issues = checkTemplate({ category: draft.category, body: draft.body, dltTemplateId: draft.dltTemplateId || null, dltText: draft.dltText || null, forIndia });
  const friendly = toGsmFriendly(draft.body);
  const length = Array.from(draft.body).length;

  const insert = (v: SmsVariable) => {
    const el = area.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    const next = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft({ ...draft, body: next });
    // Put the cursor after what was inserted, once React has written the new text.
    requestAnimationFrame(() => {
      if (!area.current) return;
      area.current.focus();
      area.current.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = { name: draft.name, category: draft.category, body: draft.body, countries: draft.countries, dltTemplateId: forIndia ? draft.dltTemplateId || null : null, dltText: forIndia ? draft.dltText || null : null };
    try {
      if (id) {
        await api(`${base}/templates/${id}`, { method: "PUT", body });
        await detail.reload();
      } else {
        const r = await api<{ template: SmsTemplate }>(`${base}/templates`, { method: "POST", body });
        setId(r.template.id);
      }
      toast("success", t?.approvedVersion ? "Saved as a new version. The approved version keeps sending until this one is approved." : "Saved as a draft. Submit it for review when it's ready.");
      onChanged();
    } catch (e) {
      setError(smsError(e, "save the template"));
    } finally {
      setSaving(false);
    }
  };

  const act = (action: TemplateAction, done: string, withNote?: string) =>
    run(action, `${action} the template`, async () => {
      await api(`${base}/templates/${id}/${action}`, { method: "POST", body: withNote ? { note: withNote } : {} });
      await detail.reload();
      onChanged();
      return done;
    });

  const latestStatus = t?.latestStatus ?? "draft";
  const can = (a: TemplateAction) => (a === "archive" || a === "restore" ? !!t && templateCan(t.status, a) : !!t && !archived && templateCan(latestStatus, a));

  return (
    <section className="card animate-rise border-accent/40" aria-labelledby="tpl-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="tpl-h" className="flex flex-wrap items-center gap-2 font-semibold">
            {t ? t.name : "New template"}
            {t && <StatusPill map={TEMPLATE_STATUS} status={t.status} />}
            {t && <span className="text-xs font-normal text-muted">version {t.latestVersion}{t.approvedVersion ? ` · version ${t.approvedVersion} approved` : ""}</span>}
          </h2>
          {t?.approvedVersion && t.latestVersion !== t.approvedVersion && (
            <p className="mt-1 text-xs text-muted">Version {t.approvedVersion} keeps sending until the latest version is approved.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {manage && t && !archived && (
            <Link className="btn-secondary h-8 px-3 text-xs" href={`/messaging/send?template=${t.id}`}>
              Send test
            </Link>
          )}
          <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {archived && <div className="mt-3"><Alert kind="info">This template is archived: restore it to edit it or use it again.</Alert></div>}
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="tpl-name">Name</label>
              <input id="tpl-name" className="input" maxLength={80} value={draft.name} disabled={!editable} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Order shipped" />
            </div>
            <div>
              <label className="label" htmlFor="tpl-cat">Category</label>
              <select id="tpl-cat" className="input" value={draft.category} disabled={!editable} onChange={(e) => setDraft({ ...draft, category: e.target.value as SmsCategory })}>
                {SMS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-xs text-muted">
            {draft.category === "marketing"
              ? "Marketing texts only reach customers subscribed to your SMS marketing in Shopify, and must carry the opt-out link."
              : "Order and delivery updates go to customers on the basis you chose in Sender Configuration. They can't carry discount codes or checkout links."}
          </p>

          <div>
            <div className="flex items-end justify-between gap-2">
              <label className="label" htmlFor="tpl-body">Message</label>
              <span className={`mb-1 text-xs tabular-nums ${length > SMS_MAX_BODY ? "text-danger" : "text-muted"}`}>{fmtNum(length)} / {fmtNum(SMS_MAX_BODY)}</span>
            </div>
            <textarea
              id="tpl-body"
              ref={area}
              className="input min-h-36 font-mono text-[13px]"
              value={draft.body}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder="Hi {{customer_name}}, your {{store_name}} order {{order_number}} is on its way: {{tracking_url}}"
            />
          </div>

          {editable && (
            <div>
              <p className="label">Insert a variable</p>
              <div className="flex flex-wrap gap-1.5">
                {SMS_VARIABLES.map((v) => (
                  <button key={v} type="button" className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-bg" title={SMS_VARIABLE_INFO[v].description} onClick={() => insert(v)}>
                    {SMS_VARIABLE_INFO[v].label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted">Hover a variable to see what fills it. Values longer than allowed are shortened (names) or stop the text (links, codes).</p>
            </div>
          )}

          <CountryPicker
            label="Countries it goes to"
            value={draft.countries}
            disabled={!editable}
            onChange={(countries) => setDraft({ ...draft, countries })}
            help="Used for the cost estimate, and for India's DLT check."
          />

          {forIndia && (
            <fieldset className="min-w-0 space-y-3 rounded-lg border border-border p-3" disabled={!editable}>
              <legend className="px-1 text-sm font-medium">India (DLT registration)</legend>
              <div>
                <label className="label" htmlFor="tpl-dlt-id">DLT Template ID</label>
                <input id="tpl-dlt-id" className="input font-mono" inputMode="numeric" maxLength={30} value={draft.dltTemplateId} onChange={(e) => setDraft({ ...draft, dltTemplateId: e.target.value.replace(/\D/g, "") })} />
              </div>
              <div>
                <label className="label" htmlFor="tpl-dlt-text">Template as registered on the DLT portal</label>
                <textarea id="tpl-dlt-text" className="input min-h-24 font-mono text-[13px]" value={draft.dltText} onChange={(e) => setDraft({ ...draft, dltText: e.target.value })} placeholder="Hi {#var#}, your order {#var#} is on its way" />
                <p className="mt-1 text-xs text-muted">Word for word, with {"{#var#}"} where each variable goes. Indian carriers reject texts that differ.</p>
              </div>
            </fieldset>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <div>
            <p className="label">Preview (sample values)</p>
            <TextBubble>{text || <span className="text-muted">(no text yet)</span>}</TextBubble>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Encoding</dt>
              <dd>{now.encoding === "GSM" ? "GSM-7" : "Unicode"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Characters</dt>
              <dd className="tabular-nums">{fmtNum(now.characters)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Parts now</dt>
              <dd className="tabular-nums">{now.segments}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">With long values</dt>
              <dd className="tabular-nums">up to {worst.segments} part{worst.segments === 1 ? "" : "s"}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted">
            {now.segments ? `${fmtNum(now.remaining)} more character${now.remaining === 1 ? "" : "s"} fit in the last part. ` : ""}
            {now.encoding === "GSM" ? "One part holds 160 characters (153 each when there are several)." : "Unicode parts hold 70 characters (67 each when there are several)."} AWS bills each part.
          </p>
          {now.nonGsm.length > 0 && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p>
                These characters make the text Unicode: <span className="font-mono">{now.nonGsm.map((c) => (c === " " ? "(non-breaking space)" : c)).join(" ")}</span>
              </p>
              {editable && friendly !== draft.body && (
                <button type="button" className="btn-secondary mt-2 h-8 px-3 text-xs" onClick={() => setDraft({ ...draft, body: friendly })}>
                  Replace typographic characters
                </button>
              )}
            </div>
          )}
          <div>
            <p className="label">Checks</p>
            <Issues issues={issues} />
          </div>
          <div>
            <p className="label">Cost per text</p>
            <Prices base={base} draft={draft} />
          </div>
        </div>
      </div>

      {manage && (
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
          {editable && (
            <button type="button" className="btn-primary" disabled={saving || !dirty || !draft.name.trim() || hasErrors(issues)} onClick={() => void save()}>
              {saving ? "Saving…" : id ? "Save changes" : "Save draft"}
            </button>
          )}
          {editable && dirty && t && (
            <button type="button" className="btn-secondary" disabled={saving} onClick={() => setDraft(saved)}>
              Discard changes
            </button>
          )}
          {t && can("submit") && (
            <button type="button" className="btn-secondary" disabled={!!busy || dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => void act("submit", "Sent for review. An owner or admin approves it before it is used.")}>
              Submit for review
            </button>
          )}
          {t && can("approve") && (
            <button type="button" className="btn-primary" disabled={!!busy || dirty} onClick={() => void act("approve", "Approved. Workflows, campaigns and Send SMS use this version from now on.")}>
              Approve
            </button>
          )}
          {t && can("reject") && (
            <button type="button" className="btn-secondary" disabled={!!busy || dirty} onClick={() => setRejecting(true)}>
              Send back…
            </button>
          )}
          {t && can("archive") && (
            <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => setArchiving(true)}>
              Archive…
            </button>
          )}
          {t && can("restore") && (
            <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void act("restore", "Restored.")}>
              Restore
            </button>
          )}
          {hasErrors(issues) && editable && <p className="text-xs text-danger">Fix the problems above to save.</p>}
        </div>
      )}

      {detail.data && (
        <details className="mt-5 border-t border-border pt-4">
          <summary className="cursor-pointer text-sm font-semibold">Version history</summary>
          <ol className="mt-3 space-y-3">
            {detail.data.versions.map((v) => (
              <li key={v.version} className="rounded-lg border border-border p-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {v.version}</span>
                  <StatusPill map={TEMPLATE_STATUS} status={v.status} />
                  <Badge tone="neutral">{v.category === "marketing" ? "Marketing" : "Transactional"}</Badge>
                  <span className="text-xs text-muted">
                    {v.encoding === "GSM" ? "GSM-7" : "Unicode"} · up to {v.segments} part{v.segments === 1 ? "" : "s"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted">
                  Written by {whoLabel(v.createdBy, meId, v.createdByName)} {fmtWhen(v.createdAt, store?.timezone)}
                  {v.submittedAt ? ` · submitted ${fmtWhen(v.submittedAt, store?.timezone)}` : ""}
                  {v.approvedAt ? ` · approved by ${whoLabel(v.approvedBy, meId, v.approvedByName)} ${fmtWhen(v.approvedAt, store?.timezone)}` : ""}
                </p>
                {v.reviewNote && <p className="mt-1 text-xs">Review note: {v.reviewNote}</p>}
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-bg p-2 font-mono text-xs">{v.body}</pre>
              </li>
            ))}
          </ol>
          {detail.data.history.length > 0 && (
            <>
              <p className="mt-4 text-sm font-semibold">What happened</p>
              <ul className="mt-2 space-y-1 text-xs text-muted">
                {detail.data.history.map((h, i) => (
                  <li key={i}>
                    {fmtWhen(h.at, store?.timezone)} · {actionLabel(h.action)}
                    {h.version ? ` (version ${h.version})` : ""} by {whoLabel(h.actorUserId, meId, h.actor)}
                    {typeof h.metadata?.note === "string" ? ` · “${h.metadata.note}”` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}

      <ConfirmDialog
        open={rejecting}
        title="Send this version back?"
        confirmLabel="Send back"
        busy={busy === "reject"}
        onCancel={() => setRejecting(false)}
        onConfirm={() =>
          void act("reject", "Sent back to draft.", note.trim() || undefined).then((ok) => {
            if (ok) {
              setRejecting(false);
              setNote("");
            }
          })
        }
      >
        <p>It goes back to draft for its author to change. Say what to change (optional):</p>
        <label className="sr-only" htmlFor="tpl-note">Note for the author</label>
        <textarea id="tpl-note" className="input min-h-20 text-text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog
        open={archiving}
        title={`Archive "${t?.name ?? ""}"?`}
        confirmLabel="Archive"
        danger
        busy={busy === "archive"}
        onCancel={() => setArchiving(false)}
        onConfirm={() => void act("archive", "Archived.").then(() => setArchiving(false))}
      >
        <p>Nothing can use it while it is archived. Workflows or campaigns still using it have to be disabled first. You can restore it later.</p>
      </ConfirmDialog>
    </section>
  );
}
