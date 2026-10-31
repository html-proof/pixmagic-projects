"use client";
import { useState } from "react";
import { previewSms } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { useApi } from "@/lib/api";
import { countryName, fmtWhen, TEMPLATE_STATUS, templateState, useSms } from "./MessagingUi";
import { TemplateEditor } from "./TemplateEditor";
import type { SmsTemplate } from "./types";

/** Message Templates: every text starts from one, and only an approved version ever reaches a customer. */
export function MessageTemplates() {
  const { base, manage, store } = useSms();
  const [archived, setArchived] = useState(false);
  const { data, error, reload, loading } = useApi<{ templates: SmsTemplate[] }>(base ? `${base}/templates${archived ? "?archived=1" : ""}` : null);
  const [open, setOpen] = useState<{ id: string | null; key: number } | null>(null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Message Templates"
        sub="Write each text once, with variables such as the customer's first name or the order number. A template is reviewed and approved by an owner or admin before it can be sent; editing an approved one makes a new version, and the approved one keeps sending until the new one is approved."
        actions={
          manage && !open ? (
            <button type="button" className="btn-primary" onClick={() => setOpen({ id: null, key: Date.now() })}>
              New template
            </button>
          ) : undefined
        }
      />
      {open && (
        <TemplateEditor
          key={open.key}
          id={open.id}
          onClose={() => setOpen(null)}
          onChanged={() => void reload()}
        />
      )}
      <section className="card" aria-labelledby="tpl-list-h">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="tpl-list-h" className="font-semibold">
            Templates
          </h2>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        {error ? (
          <div className="mt-3">
            <LoadError what="your templates" error={error} onRetry={() => void reload()} busy={loading} />
          </div>
        ) : !data ? (
          <div className="mt-3">
            <Skeleton lines={3} />
          </div>
        ) : !data.templates.length ? (
          <div className="mt-3">
            <Empty>{archived ? "No templates yet." : "No templates yet. Start with an order update, such as “your order has shipped”."}</Empty>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.templates.map((t) => {
              const body = t.approvedBody ?? t.body ?? "";
              return (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {t.name}
                      <Badge tone={TEMPLATE_STATUS[t.status]?.tone ?? "neutral"}>{templateState(t)}</Badge>
                      <span className="text-xs font-normal text-muted">{t.category === "marketing" ? "Marketing" : "Transactional"}</span>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">{previewSms(body)}</p>
                    <p className="mt-1 text-xs text-muted">
                      {t.encoding ? `${t.encoding === "GSM" ? "GSM-7" : "Unicode"} · ` : ""}
                      {t.segments ? `up to ${t.segments} part${t.segments === 1 ? "" : "s"} · ` : ""}
                      {t.countries.length ? `${t.countries.map(countryName).join(", ")} · ` : ""}
                      updated {fmtWhen(t.updatedAt, store?.timezone)}
                    </p>
                  </div>
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setOpen({ id: t.id, key: Date.now() })} aria-label={`${manage ? "Open" : "View"} ${t.name}`}>
                    {manage ? "Open" : "View"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
