"use client";
import { useMemo, useRef, useState } from "react";
import {
  renderWaText,
  WA_CATEGORY_INFO,
  WA_STARTER_TEMPLATES,
  WA_TEMPLATE_CATEGORIES,
  WA_TEXT_MAX,
  WA_VARIABLE_INFO,
  WA_VARIABLES,
  waHasErrors,
  waTemplateIssues,
  type WaTemplateCategory,
  type WaValues,
} from "@app/shared/whatsapp";
import { ConfirmDialog, Dialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Chip, SoftBox } from "./MarketingKit";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { Alert, EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { Drawer, plural } from "./ListUi";
import type { WaOverview, WaTemplate, WaTemplatesResponse } from "./types";
import { fmtAgo, useWaAction, WaBubble } from "./WaUi";

// ---------------------------------------------------------------------------
// Message templates (docs/whatsapp.md, "Templates"): the store's own wording with {{variables}}.
// On a linked phone nobody reviews them; on the Cloud API each one also goes to Meta, and a
// business-started message can only use one Meta approved. Each template is a white card as the
// Stitch design's Marketing screens draw them, its text in a phone-style bubble.
// ---------------------------------------------------------------------------

const META_TONE: Record<string, Tone> = { APPROVED: "good", PENDING: "warn", IN_APPEAL: "warn", REJECTED: "danger", PAUSED: "danger", DISABLED: "danger", DELETED: "danger" };
const metaLabel = (s: string | null) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ") : "Not submitted");

interface Draft {
  id?: string;
  name: string;
  category: WaTemplateCategory;
  body: string;
  active: boolean;
}

const blank: Draft = { name: "", category: "transactional", body: "", active: true };

export function Templates({ base, overview, reload }: { base: string; overview: WaOverview; reload: () => void }) {
  const list = useApi<WaTemplatesResponse>(`${base}/templates`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [choosing, setChoosing] = useState(false);
  const cloud = overview.connection?.provider === "cloud_api";
  const manage = overview.can.manage;

  const refresh = () => {
    void list.reload();
    reload();
  };

  let body;
  if (list.error) body = <LoadError what="the templates" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />;
  else if (!list.data) body = <Skeleton lines={4} />;
  else if (!list.data.templates.length)
    body = (
      <EmptyState
        title="No templates yet"
        body={
          manage
            ? "A template is a message your automations, campaigns and team send, with variables such as the customer's first name filled in for each one. Start from a ready-made one or a blank page."
            : "No message templates have been written for this store yet."
        }
        action={
          manage ? (
            <button type="button" className="btn-primary" onClick={() => setChoosing(true)}>
              New template
            </button>
          ) : undefined
        }
      />
    );
  else
    body = (
      <ul className="grid gap-4 lg:grid-cols-2">
        {list.data.templates.map((t) => (
          <TemplateRow key={t.id} t={t} cloud={cloud} manage={manage} onEdit={() => setDraft({ id: t.id, name: t.name, category: t.category, body: t.body, active: t.active })} base={base} onChanged={refresh} />
        ))}
      </ul>
    );

  return (
    <div className="space-y-4">
      <div className="home-card animate-rise p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="home-h2">Message templates</h2>
            <p className="mt-1 text-sm text-muted">
              {cloud
                ? "On Meta's Cloud API, each template is also submitted to Meta for review. A message that starts a conversation can only use a template Meta approved."
                : "On a linked phone, templates are your store's own wording: nobody reviews them. Keep them clear, and make marketing messages say how to stop them."}
            </p>
          </div>
          {manage && !!list.data?.templates.length && (
            <button type="button" className="btn-primary" onClick={() => setChoosing(true)}>
              New template
            </button>
          )}
        </div>
      </div>
      {body}
      {choosing && (
        <StarterDialog
          onClose={() => setChoosing(false)}
          onPick={(d) => {
            setChoosing(false);
            setDraft(d);
          }}
        />
      )}
      {draft && list.data && (
        <TemplateEditor
          base={base}
          draft={draft}
          samples={list.data.samples}
          cloud={cloud}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function TemplateRow({ t, cloud, manage, onEdit, base, onChanged }: { t: WaTemplate; cloud: boolean; manage: boolean; onEdit: () => void; base: string; onChanged: () => void }) {
  const { busy, run } = useWaAction();
  const [deleting, setDeleting] = useState(false);
  const used = t.usedBy ? t.usedBy.automations + t.usedBy.campaigns : 0;
  return (
    <li className="home-card animate-rise flex min-w-0 flex-col gap-3 p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="truncate font-semibold">{t.name}</h3>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone={t.category === "marketing" ? "warn" : "neutral"}>{WA_CATEGORY_INFO[t.category]?.label ?? t.category}</Badge>
            <Badge tone={t.active ? "good" : "neutral"}>{t.active ? "Active" : "Switched off"}</Badge>
            {cloud && <Badge tone={META_TONE[t.meta?.status ?? ""] ?? "neutral"}>Meta: {metaLabel(t.meta?.status ?? null)}</Badge>}
            <span>Updated {fmtAgo(t.updatedAt)}</span>
          </p>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2">
            {cloud && (!t.meta || t.meta.status === "REJECTED" || t.meta.status === "DELETED") && (
              <button
                type="button"
                className="btn-secondary h-8 px-3 text-xs"
                disabled={!!busy}
                onClick={() =>
                  void run("submit", "submit the template to Meta", async () => {
                    await api(`${base}/templates/${t.id}/submit`, { method: "POST" });
                    onChanged();
                    return "Submitted. Meta usually reviews a template within minutes to a day.";
                  })
                }
              >
                {busy === "submit" ? "Submitting…" : "Submit to Meta for review"}
              </button>
            )}
            <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={onEdit}>
              Edit
            </button>
            <button type="button" className="btn-danger h-8 px-3 text-xs" onClick={() => setDeleting(true)} disabled={!!busy}>
              Delete
            </button>
          </div>
        )}
      </div>
      <SoftBox className="p-4">
        <WaBubble>{t.body}</WaBubble>
      </SoftBox>
      <div className="space-y-1 text-xs text-muted">
        {!t.usable && t.unusableReason && <p className="text-warn">Can&apos;t be sent now: {t.unusableReason}</p>}
        {cloud && t.meta?.reason && t.meta.reason !== "NONE" && <p>Meta&apos;s reason: {t.meta.reason}</p>}
        {t.usedBy && (
          <p>{used ? `Used by ${plural(t.usedBy.automations, "automation")} and ${plural(t.usedBy.campaigns, "unfinished campaign")}.` : "Not used by any automation or campaign."}</p>
        )}
      </div>
      <ConfirmDialog
        open={deleting}
        title={`Delete "${t.name}"?`}
        confirmLabel="Delete template"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(false)}
        onConfirm={() =>
          void run("delete", "delete the template", async () => {
            await api(`${base}/templates/${t.id}`, { method: "DELETE" });
            setDeleting(false);
            onChanged();
            return "Template deleted.";
          }).then((ok) => {
            if (!ok) setDeleting(false);
          })
        }
      >
        <p>Messages already sent keep their text. A template that an automation or an unfinished campaign uses can&apos;t be deleted: change or delete those first.</p>
      </ConfirmDialog>
    </li>
  );
}

function StarterDialog({ onClose, onPick }: { onClose: () => void; onPick: (d: Draft) => void }) {
  return (
    <Dialog open title="New template" onClose={onClose}>
      <p className="text-sm text-muted">Start from a ready-made message and change it to fit your store, or from a blank page.</p>
      <ul className="mt-3 space-y-2">
        <li>
          <button type="button" className="w-full rounded bg-home-soft px-3 py-2 text-left text-sm transition outline-none hover:bg-home-soft-hover focus-visible:ring-2 focus-visible:ring-accent" onClick={() => onPick({ ...blank })}>
            <span className="font-medium">Blank template</span>
            <span className="block text-xs text-muted">Write your own from scratch.</span>
          </button>
        </li>
        {WA_STARTER_TEMPLATES.map((s) => (
          <li key={s.key}>
            <button type="button" className="w-full rounded bg-home-soft px-3 py-2 text-left text-sm transition outline-none hover:bg-home-soft-hover focus-visible:ring-2 focus-visible:ring-accent" onClick={() => onPick({ name: s.name, category: s.category, body: s.body, active: true })}>
              <span className="font-medium">{s.name}</span>
              <span className="ml-2 text-xs text-muted">{WA_CATEGORY_INFO[s.category].label}</span>
              <span className="mt-0.5 block truncate text-xs text-muted">{s.body}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function TemplateEditor({ base, draft, samples, cloud, onClose, onSaved }: { base: string; draft: Draft; samples: WaValues; cloud: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(draft);
  const { busy, run } = useWaAction();
  const area = useRef<HTMLTextAreaElement>(null);
  const issues = useMemo(() => waTemplateIssues({ body: d.body, category: d.category }), [d.body, d.category]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const preview = useMemo(() => (d.body.trim() ? renderWaText(d.body, samples, { lenient: true }) : ""), [d.body, samples]);
  const tooLong = d.body.length > WA_TEXT_MAX;

  const insert = (v: string) => {
    const el = area.current;
    const token = `{{${v}}}`;
    const start = el?.selectionStart ?? d.body.length;
    const end = el?.selectionEnd ?? d.body.length;
    const next = d.body.slice(0, start) + token + d.body.slice(end);
    setD({ ...d, body: next });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = () =>
    run("save", "save the template", async () => {
      const payload = { name: d.name.trim(), category: d.category, body: d.body, active: d.active };
      if (d.id) await api(`${base}/templates/${d.id}`, { method: "PUT", body: payload });
      else await api(`${base}/templates`, { method: "POST", body: payload });
      onSaved();
      return d.id ? (cloud ? "Saved. A changed text needs Meta's review again: submit it when you're ready." : "Template saved.") : "Template created.";
    });

  return (
    <Drawer title={d.id ? "Edit template" : "New template"} sub={cloud ? "Meta reviews it before it can start a conversation" : "Sent from your linked phone as written"} onClose={onClose}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && d.name.trim() && !waHasErrors(issues)) void save();
        }}
      >
        <div>
          <label className="label" htmlFor="wa-tpl-name">
            Name
          </label>
          <input id="wa-tpl-name" className="input" maxLength={80} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Order confirmation" />
          <p className="mt-1 text-xs text-muted">Only your team sees it.</p>
        </div>
        <fieldset>
          <legend className="label">Kind of message</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WA_TEMPLATE_CATEGORIES.map((c) => (
              <label key={c} className={`flex cursor-pointer flex-col gap-1 rounded border p-3 text-sm transition ${d.category === c ? "border-accent bg-accent/10" : "border-transparent bg-home-soft hover:bg-home-soft-hover"}`}>
                <span className="flex items-center gap-2 font-medium">
                  <input type="radio" name="wa-tpl-category" className="accent-[var(--accent)]" checked={d.category === c} onChange={() => setD({ ...d, category: c })} />
                  {WA_CATEGORY_INFO[c].label}
                </span>
                <span className="text-xs text-muted">{WA_CATEGORY_INFO[c].help}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="wa-tpl-body">
            Message
          </label>
          <textarea
            id="wa-tpl-body"
            ref={area}
            className="input min-h-36 font-[inherit]"
            value={d.body}
            onChange={(e) => setD({ ...d, body: e.target.value })}
            aria-describedby="wa-tpl-count wa-tpl-vars"
            placeholder="Hi {{customer_first_name}}, thanks for your order {{order_number}}!"
          />
          <p id="wa-tpl-count" className={`mt-1 text-xs ${tooLong ? "text-danger" : "text-muted"}`}>
            {d.body.length} / {WA_TEXT_MAX} characters
          </p>
          <div id="wa-tpl-vars" className="mt-2">
            <p className="text-xs text-muted">Insert a variable (each is filled in from the order or customer the message is about):</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {WA_VARIABLES.map((v) => (
                <button key={v} type="button" className="rounded outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => insert(v)} title={`{{${v}}}`}>
                  <Chip>{WA_VARIABLE_INFO[v].label}</Chip>
                </button>
              ))}
            </div>
          </div>
        </div>
        {errors.length > 0 && (
          <Alert kind="error">
            <ul className="list-disc space-y-0.5 pl-4">
              {errors.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert kind="info">
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((i) => (
                <li key={i.message}>{i.message}</li>
              ))}
            </ul>
          </Alert>
        )}
        <div>
          <p className="label">Preview, with sample values</p>
          <SoftBox className="p-4">{preview ? <WaBubble>{preview}</WaBubble> : <p className="text-sm text-muted">Write the message to see it here.</p>}</SoftBox>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[var(--accent)]" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />
          Active (switched off, nothing sends it)
        </label>
        <div className="flex flex-wrap justify-end gap-2 border-t border-home-line pt-4">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!!busy || !d.name.trim() || waHasErrors(issues)}>
            {busy === "save" ? "Saving…" : d.id ? "Save changes" : "Create template"}
          </button>
        </div>
      </form>
    </Drawer>
  );
}
