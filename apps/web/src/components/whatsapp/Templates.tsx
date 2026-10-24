"use client";
import { useState } from "react";
import { TEMPLATE_LANGUAGES } from "@app/shared/whatsapp";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { EmptyState } from "@/components/ui";
import { api, useApi } from "@/lib/api";
import { TemplateWriter } from "./TemplateWriter";
import type { WaOverview, WaTemplate, WaTemplatesAnswer } from "./types";
import { templateTone, TemplatePreview, useWaAction } from "./WaUi";

const languageLabel = (code: string) => TEMPLATE_LANGUAGES.find((l) => l.code === code)?.label ?? code;
const CATEGORY_LABEL: Record<string, string> = { UTILITY: "Order and service updates", MARKETING: "Marketing", AUTHENTICATION: "Authentication (not used here)" };

/** The store's message templates: what Meta approved, what is waiting, and writing new ones. */
export function Templates({ base, overview }: { base: string; overview: WaOverview }) {
  const { data, error, loading, reload } = useApi<WaTemplatesAnswer>(`${base}/templates`);
  const [writing, setWriting] = useState(false);
  const [deleting, setDeleting] = useState<WaTemplate | null>(null);
  const { busy, run } = useWaAction();
  const can = overview.can;
  const connected = !!overview.connection && overview.connection.status !== "disconnected";
  if (error) return <LoadError what="your templates" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data) return <Skeleton lines={5} />;
  if (writing) return <TemplateWriter base={base} starters={data.starters} onCancel={() => setWriting(false)} onDone={() => { setWriting(false); void reload(); }} />;

  const refresh = () =>
    run("sync", "refresh the templates", async () => {
      const r = await api<{ count: number }>(`${base}/templates/sync`, { method: "POST", body: {} });
      await reload();
      return `Read ${r.count} template${r.count === 1 ? "" : "s"} from WhatsApp.`;
    });
  const test = (t: WaTemplate) =>
    run(`test:${t.id}`, "send the test", async () => {
      await api(`${base}/templates/${t.id}/test`, { method: "POST", body: {} });
      return "Test sent to your own number. Check WhatsApp on your phone.";
    });

  return (
    <div className="space-y-4">
      <section className="card animate-rise">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-semibold">Message templates</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              WhatsApp lets a business start a conversation only with a template Meta approved. Write one here (or in WhatsApp Manager), and use it in workflows and campaigns once it&apos;s approved.
            </p>
          </div>
          {can.manage && connected && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => void refresh()} disabled={busy === "sync"}>
                {busy === "sync" ? "Refreshing…" : "Refresh from WhatsApp"}
              </button>
              <button type="button" className="btn-primary" onClick={() => setWriting(true)}>
                New template
              </button>
            </div>
          )}
        </div>
      </section>
      {!data.templates.length ? (
        <EmptyState
          title="No templates yet"
          body={connected ? "Start from one written for order confirmations, shipping updates, reminders or offers. Meta usually reviews it within minutes." : "Connect WhatsApp first: templates live in your WhatsApp Business account."}
          action={
            can.manage && connected ? (
              <button type="button" className="btn-primary" onClick={() => setWriting(true)}>
                Write your first template
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.templates.map((t) => (
            <article key={t.id} className="card animate-rise space-y-3" data-testid="wa-template">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{t.name}</h3>
                  <p className="text-xs text-muted">
                    {languageLabel(t.language)} · {CATEGORY_LABEL[t.category] ?? t.category}
                    {t.usedBy && (t.usedBy.workflows || t.usedBy.campaigns) ? ` · used by ${t.usedBy.workflows} workflow${t.usedBy.workflows === 1 ? "" : "s"}, ${t.usedBy.campaigns} campaign${t.usedBy.campaigns === 1 ? "" : "s"}` : ""}
                  </p>
                </div>
                <Badge tone={templateTone(t.status)}>{t.statusLabel}</Badge>
              </div>
              {t.rejectedReason && <p className="text-sm text-danger">Meta&apos;s reason: {t.rejectedReason.toLowerCase().replace(/_/g, " ")}</p>}
              <TemplatePreview components={t.components} mapping={null} />
              {can.manage && (
                <div className="flex flex-wrap gap-2">
                  {t.status === "APPROVED" && (
                    <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void test(t)} disabled={busy === `test:${t.id}`}>
                      {busy === `test:${t.id}` ? "Sending…" : "Send a test to me"}
                    </button>
                  )}
                  <button type="button" className="btn-secondary h-8 px-3 text-xs text-danger" onClick={() => setDeleting(t)}>
                    Delete
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete template"
        danger
        busy={busy === "delete"}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void run("delete", "delete the template", async () => {
            await api(`${base}/templates/${deleting!.id}`, { method: "DELETE" });
            setDeleting(null);
            await reload();
            return "Template deleted from your WhatsApp account.";
          })
        }
      >
        <p>It is deleted from your WhatsApp Business account too. Meta doesn&apos;t let a deleted template&apos;s name be used again for 30 days.</p>
      </ConfirmDialog>
    </div>
  );
}
