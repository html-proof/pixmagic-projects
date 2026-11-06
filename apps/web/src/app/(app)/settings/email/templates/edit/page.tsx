"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { eventLabel, type EventField } from "@app/shared/email";
import { StepCard } from "@/components/automations/MarketingKit";
import { EmailPreviewFrame, Note } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
import { Field, Tabs } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { fmtDateTime, useEmail, type CatalogResponse, type RenderedPreview, type TemplateView } from "@/lib/email";

interface Draft {
  name: string;
  description: string;
  category: "transactional" | "marketing";
  eventType: string | null;
  subject: string;
  html: string;
  text: string;
  replyTo: string;
}

const EMPTY: Draft = {
  name: "",
  description: "",
  category: "transactional",
  eventType: "order.paid",
  subject: "Thanks for your order {{order.id}}",
  html: '<p>Hi {{customer.first_name | default: "there"}},</p>\n<p>Thanks for your order {{order.id}}. We\'re getting it ready.</p>\n<p>{{business.name}}</p>',
  text: "",
  replyTo: "",
};

export default function TemplateEditorPage() {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Editor />
    </Suspense>
  );
}

function Editor() {
  const id = useSearchParams().get("id");
  const { base, automate } = useEmail();
  const router = useRouter();
  const existing = useApi<{ template: TemplateView; versions: Array<{ version: number; createdAt: string; subject: string }> }>(id ? `${base}/templates/${id}` : null);
  const catalog = useApi<CatalogResponse>(`${base}/catalog`);
  const [draft, setDraft] = useState<Draft | null>(id ? null : EMPTY);
  const [customType, setCustomType] = useState("");
  const [tab, setTab] = useState<"html" | "text">("html");
  const [preview, setPreview] = useState<RenderedPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, run } = useAction();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const [lastFocus, setLastFocus] = useState<"subject" | "html" | "text">("html");

  const t = existing.data?.template;
  useEffect(() => {
    if (t && !draft) {
      setDraft({ name: t.name, description: t.description ?? "", category: t.category, eventType: t.eventType, subject: t.subject, html: t.html, text: t.text, replyTo: t.replyTo ?? "" });
      if (t.eventType && !catalog.data?.events.some((e) => e.type === t.eventType)) setCustomType(t.eventType);
    }
  }, [t, draft, catalog.data]);

  // Live preview, a moment after typing stops.
  useEffect(() => {
    if (!draft || !automate) return;
    const timer = window.setTimeout(async () => {
      try {
        const r = await api<{ preview: RenderedPreview }>(`${base}/templates/preview`, { method: "POST", body: { ...draft, replyTo: draft.replyTo || null, description: draft.description || null } });
        setPreview(r.preview);
        setPreviewErr(null);
      } catch (e) {
        setPreviewErr(e instanceof ApiError && e.status === 400 ? e.message : actionError(e, "preview the template"));
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, base, automate]);

  const variables: EventField[] = useMemo(() => {
    if (!catalog.data || !draft) return [];
    const ev = catalog.data.events.find((e) => e.type === draft.eventType);
    const own = ev ? ev.fields : catalog.data.customEvents.fields;
    return [...own, ...catalog.data.globalVariables, ...(draft.category === "marketing" ? [catalog.data.unsubscribeVariable] : [])];
  }, [catalog.data, draft]);

  if (existing.error && !existing.data) return <LoadError what="the template" error={existing.error} onRetry={existing.reload} busy={existing.loading} />;
  if (catalog.error && !catalog.data) return <LoadError what="the event list" error={catalog.error} onRetry={catalog.reload} busy={catalog.loading} />;
  if (!draft || !catalog.data) return <Skeleton lines={8} />;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  function insert(path: string) {
    const token = `{{${path}}}`;
    if (lastFocus === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const at = el.selectionStart ?? draft!.subject.length;
      set("subject", draft!.subject.slice(0, at) + token + draft!.subject.slice(at));
      return;
    }
    const key = lastFocus === "text" ? "text" : "html";
    const el = htmlRef.current;
    const value = draft![key];
    const at = el && tab === key ? (el.selectionStart ?? value.length) : value.length;
    set(key, value.slice(0, at) + token + value.slice(at));
  }

  async function save(status?: "draft" | "active") {
    setErr(null);
    setProblems([]);
    const body = { ...draft!, replyTo: draft!.replyTo || null, description: draft!.description || null, ...(status ? { status } : {}) };
    await run("save", "save the template", async () => {
      try {
        if (id) {
          await api(`${base}/templates/${id}`, { method: "PATCH", body });
          await existing.reload();
          return status === "active" ? "Saved and active." : "Saved.";
        }
        const r = await api<{ template: TemplateView }>(`${base}/templates`, { method: "POST", body: { ...body, status: status ?? "draft" } });
        router.replace(`/settings/email/templates/edit?id=${r.template.id}`);
        return "Template created.";
      } catch (e) {
        if (e instanceof ApiError && Array.isArray(e.data.detail && (e.data.detail as { problems?: string[] }).problems)) setProblems((e.data.detail as { problems: string[] }).problems);
        throw e;
      }
    });
  }

  const readOnly = !automate;
  return (
    <div className="space-y-4">
      <PageHeader
        title={id ? `Template: ${t?.name ?? ""}` : "New template"}
        sub={id && t ? `Version ${t.version} · ${t.status === "active" ? "Active" : t.status === "draft" ? "Draft" : "Archived"} · last saved ${fmtDateTime(t.updatedAt)}` : "Write the email; preview it with example data on the right."}
        actions={<Link className="btn-secondary" href="/settings/email/templates">All templates</Link>}
      />
      {err && <Alert>{err}</Alert>}
      {problems.length > 1 && (
        <Alert>
          <ul className="list-disc pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {/* As the Stitch design's screen 19 lays out one automation: the numbered parts on the left, what it will look like beside them. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <StepCard id="t-step-about" n={1} title="What it's for">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required htmlFor="t-name">
                <input id="t-name" className="input" maxLength={100} disabled={readOnly} value={draft.name} onChange={(e) => set("name", e.target.value)} />
              </Field>
              <Field label="Type" htmlFor="t-cat" hint={draft.category === "marketing" ? "Only sent to customers who agreed to marketing; an unsubscribe link and your address are added." : "Answers something the customer did (order, booking, invoice)."}>
                <select id="t-cat" className="input" disabled={readOnly} value={draft.category} onChange={(e) => set("category", e.target.value as Draft["category"])}>
                  <option value="transactional">Transactional</option>
                  <option value="marketing">Marketing</option>
                </select>
              </Field>
              <Field label="Used for" htmlFor="t-event" hint="Decides which placeholders are available.">
                <select
                  id="t-event"
                  className="input"
                  disabled={readOnly}
                  value={catalog.data.events.some((e) => e.type === draft.eventType) ? (draft.eventType ?? "") : draft.eventType ? "custom" : ""}
                  onChange={(e) => set("eventType", e.target.value === "custom" ? customType || null : e.target.value || null)}
                >
                  <option value="">Any event (customer and business details only)</option>
                  {catalog.data.events.map((e) => (
                    <option key={e.type} value={e.type}>
                      {e.label}
                    </option>
                  ))}
                  <option value="custom">A custom event…</option>
                </select>
              </Field>
              {draft.eventType !== null && !catalog.data.events.some((e) => e.type === draft.eventType) && (
                <Field label="Custom event name" htmlFor="t-custom" hint={`For example ${catalog.data.customEvents.examples.slice(0, 2).join(" or ")}.`}>
                  <input
                    id="t-custom"
                    className="input"
                    disabled={readOnly}
                    value={customType}
                    onChange={(e) => {
                      setCustomType(e.target.value.trim().toLowerCase());
                      set("eventType", e.target.value.trim().toLowerCase() || null);
                    }}
                  />
                </Field>
              )}
            </div>
          </StepCard>
          <StepCard id="t-step-email" n={2} title="The email">
            <Field label="Subject" required htmlFor="t-subject">
              <input id="t-subject" ref={subjectRef} className="input" maxLength={250} disabled={readOnly} value={draft.subject} onFocus={() => setLastFocus("subject")} onChange={(e) => set("subject", e.target.value)} />
            </Field>
            <Tabs tabs={[["html", "HTML"], ["text", "Plain text"]] as const} value={tab} onChange={setTab} label="Body" />
            <textarea
              ref={htmlRef}
              aria-label={tab === "html" ? "HTML body" : "Plain-text body"}
              className="input min-h-[18rem] font-mono text-xs"
              disabled={readOnly}
              value={tab === "html" ? draft.html : draft.text}
              placeholder={tab === "text" ? "Leave empty to generate it from the HTML." : ""}
              onFocus={() => setLastFocus(tab)}
              onChange={(e) => set(tab, e.target.value)}
            />
            <details open>
              <summary className="cursor-pointer text-sm font-medium">Insert a placeholder</summary>
              <div className="mt-2 flex flex-wrap gap-1">
                {variables.map((v) => (
                  <button key={v.path} type="button" disabled={readOnly} className="rounded bg-home-tag px-2 py-0.5 text-xs font-medium transition-colors outline-none hover:bg-home-soft-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60" title={v.label} onClick={() => insert(v.path)}>
                    {v.path}
                  </button>
                ))}
                {draft.eventType && !catalog.data.events.some((e) => e.type === draft.eventType) && <span className="text-xs text-muted">Custom events can also use data.&lt;field&gt; for any field your system sends.</span>}
              </div>
              <p className="mt-2 text-xs text-muted">
                A fallback for missing values: <code>{'{{customer.first_name | default: "there"}}'}</code>. Scripts, forms and embedded content are removed when you save.
              </p>
            </details>
            <Field label="Reply-to address" htmlFor="t-reply" hint="Optional; the sending account's reply-to is used otherwise.">
              <input id="t-reply" className="input" type="email" disabled={readOnly} value={draft.replyTo} onChange={(e) => set("replyTo", e.target.value)} />
            </Field>
          </StepCard>
          {automate && (
            <StepCard id="t-step-save" n={3} title="Test and save">
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={!!busy} onClick={() => save()}>
                  {busy === "save" ? "Saving…" : "Save"}
                </button>
                {t?.status !== "active" && (
                  <button className="btn-primary" disabled={!!busy} onClick={() => save("active")}>
                    Save and activate
                  </button>
                )}
                {id && (
                  <>
                    <button
                      className="btn-secondary"
                      disabled={!!busy}
                      onClick={() =>
                        run("test", "send a test", async () => {
                          const r = await api<{ result: { status: string; message: string | null } }>(`${base}/templates/${id}/test`, { method: "POST", body: {} });
                          if (r.result.status !== "accepted_by_provider") throw new Error(r.result.message ?? `Not sent (${r.result.status})`);
                          return "Test sent to your own address, with example data.";
                        })
                      }
                    >
                      Send test to me
                    </button>
                    <button
                      className="btn-secondary"
                      disabled={!!busy}
                      onClick={() =>
                        run("dup", "duplicate the template", async () => {
                          const r = await api<{ template: TemplateView }>(`${base}/templates/${id}/duplicate`, { method: "POST" });
                          router.push(`/settings/email/templates/edit?id=${r.template.id}`);
                          setDraft(null);
                          return "Copied as a draft.";
                        })
                      }
                    >
                      Duplicate
                    </button>
                    {t?.status === "active" && (
                      <button className="btn-secondary" disabled={!!busy} onClick={() => save("draft")}>
                        Back to draft
                      </button>
                    )}
                    <button className="btn-secondary text-danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </StepCard>
          )}
        </div>
        <Card id="t-preview" title="Preview with example data">
          <div className="space-y-3">
            {previewErr ? (
              <Alert>{previewErr}</Alert>
            ) : preview ? (
              <>
                <p className="text-sm">
                  <span className="text-muted">Subject:</span> {preview.subject}
                </p>
                <EmailPreviewFrame html={preview.html} />
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted">Plain-text version</summary>
                  <pre className="mt-2 whitespace-pre-wrap rounded bg-home-soft p-2">{preview.text}</pre>
                </details>
              </>
            ) : (
              <Skeleton lines={4} />
            )}
            <Note>Example customer: Alex Rivera, alex@example.com. Real emails use each event&apos;s own data.</Note>
            {existing.data && existing.data.versions.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold">Version history</h3>
                <ul className="mt-1 divide-y divide-home-line text-sm">
                  {existing.data.versions.map((v) => (
                    <li key={v.version} className="flex items-center gap-2 py-1.5">
                      <span className="w-10 text-muted">v{v.version}</span>
                      <span className="min-w-0 flex-1 truncate">{v.subject}</span>
                      <span className="text-xs text-muted">{fmtDateTime(v.createdAt)}</span>
                      {automate && v.version !== t?.version && (
                        <button
                          className="text-xs text-accent underline"
                          disabled={!!busy}
                          onClick={() =>
                            run("restore", "restore the version", async () => {
                              await api(`${base}/templates/${id}/versions/${v.version}/restore`, { method: "POST" });
                              setDraft(null);
                              await existing.reload();
                              return `Restored version ${v.version} as a new version.`;
                            })
                          }
                        >
                          Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {draft.eventType && <p className="text-xs text-muted">Placeholders available for: {eventLabel(draft.eventType)}.</p>}
          </div>
        </Card>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this template?"
        confirmLabel="Delete"
        danger
        busy={busy === "delete"}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const ok = await run("delete", "delete the template", async () => {
            await api(`${base}/templates/${id}`, { method: "DELETE" });
            return "Template deleted.";
          });
          setConfirmDelete(false);
          if (ok) router.push("/settings/email/templates");
        }}
      >
        <p>Templates used by an automation can&apos;t be deleted until the automation uses another one.</p>
      </ConfirmDialog>
    </div>
  );
}
