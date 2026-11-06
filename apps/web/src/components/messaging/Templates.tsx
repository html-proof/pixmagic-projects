"use client";
import { useState } from "react";
import { previewSms } from "@app/shared/sms";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Chip, TableCard } from "@/components/automations/MarketingKit";
import { Badge, Empty } from "@/components/dashboard/Primitives";
import { useApi } from "@/lib/api";
import { countryName, fmtWhen, TEMPLATE_STATUS, templateState, useSms } from "./MessagingUi";
import { TemplateEditor } from "./TemplateEditor";
import type { SmsTemplate } from "./types";

/**
 * Message Templates: every text starts from one, and only an approved version ever reaches a
 * customer. The list is a white card of rows with hairlines between them, as the Stitch design's
 * Marketing screens list automations and campaigns.
 */
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
      <TableCard
        id="tpl-list"
        title="Templates"
        actions={
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        }
      >
        {error ? (
          <div className="px-5 pb-5 sm:px-6">
            <LoadError what="your templates" error={error} onRetry={() => void reload()} busy={loading} />
          </div>
        ) : !data ? (
          <div className="px-5 pb-5 sm:px-6">
            <Skeleton lines={3} />
          </div>
        ) : !data.templates.length ? (
          <div className="px-5 pb-5 sm:px-6">
            <Empty>{archived ? "No templates yet." : "No templates yet. Start with an order update, such as “your order has shipped”."}</Empty>
          </div>
        ) : (
          <ul className="divide-y divide-home-line border-t border-home-line">
            {data.templates.map((t) => {
              const body = t.approvedBody ?? t.body ?? "";
              return (
                <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      {t.name}
                      <Badge tone={TEMPLATE_STATUS[t.status]?.tone ?? "neutral"}>{templateState(t)}</Badge>
                      <Chip tone={t.category === "marketing" ? "accent" : "plain"}>{t.category === "marketing" ? "Marketing" : "Transactional"}</Chip>
                    </p>
                    <p className="mt-1 line-clamp-2 text-sm text-muted">{previewSms(body)}</p>
                    <p className="mt-1 text-xs text-muted">
                      {t.encoding ? `${t.encoding === "GSM" ? "GSM-7" : "Unicode"} · ` : ""}
                      {t.segments ? `up to ${t.segments} part${t.segments === 1 ? "" : "s"} · ` : ""}
                      {t.countries.length ? `${t.countries.map(countryName).join(", ")} · ` : ""}
                      updated {fmtWhen(t.updatedAt, store?.timezone)}
                    </p>
                  </div>
                  <button type="button" className="home-btn h-8" onClick={() => setOpen({ id: t.id, key: Date.now() })} aria-label={`${manage ? "Open" : "View"} ${t.name}`}>
                    {manage ? "Open" : "View"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </TableCard>
    </div>
  );
}
