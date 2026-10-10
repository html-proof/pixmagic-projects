"use client";
import { useState } from "react";
import { previewText, TEMPLATE_LIBRARY } from "@app/shared/whatsapp";
import { Badge, Empty } from "@/components/dashboard/primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { LoadError } from "@/components/LoadError";
import { api, useApi } from "@/lib/api";
import { PageHeader, Skeleton, TEMPLATE_STATUS, useAction, useWa, type WaTemplate } from "@/components/whatsapp/common";
import type { Overview } from "@/components/whatsapp/types";

const bodyOf = (t: WaTemplate) => t.components.find((c) => c.type.toUpperCase() === "BODY")?.text ?? "";
const buttonsOf = (t: WaTemplate) => t.components.find((c) => c.type.toUpperCase() === "BUTTONS")?.buttons ?? [];

function Bubble({ text, buttons }: { text: string; buttons?: Array<{ type: string; text?: string }> }) {
  return (
    <div className="max-w-md">
      <div className="whitespace-pre-wrap rounded-2xl rounded-tl-sm bg-[#e7ffdb] px-4 py-3 text-sm text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">{text}</div>
      {!!buttons?.length && (
        <div className="mt-1 grid gap-1">
          {buttons.map((b, i) => (
            <span key={i} className="rounded-lg bg-surface px-3 py-1.5 text-center text-sm text-[#027eb5] shadow-sm">
              {b.type === "URL" ? "↗ " : ""}
              {b.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Templates() {
  const { base, manage } = useWa();
  const overview = useApi<Overview>(base);
  const { data, error, reload } = useApi<{ templates: WaTemplate[] }>(base ? `${base}/templates` : null);
  const { busy, run } = useAction();
  const [testFor, setTestFor] = useState<WaTemplate | null>(null);
  const [phone, setPhone] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  if (error) return <LoadError what="your templates" error={error} onRetry={() => void reload()} />;
  if (!data || !overview.data) return <Skeleton lines={5} />;
  const connected = !!overview.data.connection;
  const have = new Set(data.templates.map((t) => t.name));
  const refresh = () =>
    run("refresh", "refresh templates", async () => {
      await api(`${base}/refresh`, { method: "POST" });
      await reload();
      return "Templates updated from Meta.";
    });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Message templates"
        sub={
          <>
            WhatsApp only lets a business start a conversation with a template Meta has approved. Meta also decides each template&apos;s category: <strong>utility</strong> (order
            updates: needs the customer&apos;s agreement to updates) or <strong>marketing</strong> (offers, cart reminders: needs WhatsApp marketing consent).
          </>
        }
        actions={connected && manage ? <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => void refresh()}>{busy === "refresh" ? "Checking…" : "Refresh from Meta"}</button> : undefined}
      />

      {!connected && <Empty>Connect WhatsApp first: templates live in your WhatsApp Business Account.</Empty>}

      {connected && (
        <section className="card animate-rise" aria-labelledby="mine-h">
          <h2 id="mine-h" className="font-semibold">In your WhatsApp account ({data.templates.length})</h2>
          {!data.templates.length ? (
            <p className="mt-2 text-sm text-muted">None yet. Add Insights&apos; ready-made templates below, or create your own in WhatsApp Manager and press Refresh.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {data.templates.map((t) => {
                const st = TEMPLATE_STATUS[t.status] ?? { tone: "neutral" as const, label: t.status };
                return (
                  <li key={t.id} className="grid gap-3 py-4 md:grid-cols-[1fr_auto]">
                    <div className="min-w-0 space-y-2">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {t.name} <span className="text-xs font-normal text-muted">{t.language}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <Badge tone="neutral">{t.category.toLowerCase()}</Badge>
                        {t.qualityScore && t.qualityScore !== "UNKNOWN" ? <Badge tone={t.qualityScore === "RED" ? "danger" : t.qualityScore === "YELLOW" ? "warn" : "good"}>quality {t.qualityScore.toLowerCase()}</Badge> : null}
                      </p>
                      {t.rejectedReason && <p className="text-xs text-danger">Meta: {t.rejectedReason.toLowerCase().replace(/_/g, " ")}</p>}
                      <Bubble text={bodyOf(t)} buttons={buttonsOf(t)} />
                      <p className="text-xs text-muted">
                        {t.shape.bodyVars} variable{t.shape.bodyVars === 1 ? "" : "s"}
                        {t.shape.headerFormat !== "NONE" ? ` · ${t.shape.headerFormat.toLowerCase()} header` : ""} · updated {fmtRelative(t.updatedAt)}
                      </p>
                    </div>
                    {manage && t.status === "APPROVED" && (
                      <div>
                        <button type="button" className="btn-secondary h-9 text-xs" onClick={() => setTestFor(testFor?.id === t.id ? null : t)} aria-expanded={testFor?.id === t.id}>
                          Send a test
                        </button>
                      </div>
                    )}
                    {testFor?.id === t.id && (
                      <form
                        className="rounded-lg border border-border p-3 md:col-span-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run("test", "send the test", async () => {
                            await api(`${base}/test`, { method: "POST", body: { templateName: t.name, language: t.language, phone, ...(mediaUrl ? { mediaUrl } : {}) } });
                            return `Test sent to ${phone}. It uses example values; check Message history for its delivery.`;
                          });
                        }}
                      >
                        <p className="text-sm text-muted">Sends this template once, with example values, to your own WhatsApp. Only use a number that agreed to receive it (yours).</p>
                        <div className="mt-2 flex flex-wrap items-end gap-2">
                          <div>
                            <label className="label" htmlFor={`ph-${t.id}`}>Your WhatsApp number</label>
                            <input id={`ph-${t.id}`} className="input w-56" type="tel" placeholder="+91 98765 43210" required value={phone} onChange={(e) => setPhone(e.target.value)} />
                          </div>
                          {t.shape.headerFormat === "IMAGE" && (
                            <div className="min-w-64 flex-1">
                              <label className="label" htmlFor={`img-${t.id}`}>Header image (https link)</label>
                              <input id={`img-${t.id}`} className="input" type="url" required value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
                            </div>
                          )}
                          <button type="submit" className="btn-primary" disabled={!!busy}>{busy === "test" ? "Sending…" : "Send test"}</button>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="card animate-rise" aria-labelledby="lib-h">
        <h2 id="lib-h" className="font-semibold">Insights&apos; ready-made templates</h2>
        <p className="mt-1 text-sm text-muted">
          Written to Meta&apos;s guidelines and mapped to real order data. Submitting one adds it to your WhatsApp account for Meta&apos;s review, which usually takes minutes but can
          take up to a day. Links use your store&apos;s secure tracking and review pages.
        </p>
        <ul className="mt-3 grid gap-4 lg:grid-cols-2">
          {TEMPLATE_LIBRARY.map((lib) => (
            <li key={lib.name} className="lift rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {lib.label} <Badge tone="neutral">{lib.category.toLowerCase()}</Badge>
                </p>
                {have.has(lib.name) ? (
                  <Badge tone="good">In your account</Badge>
                ) : manage && connected ? (
                  <button
                    type="button"
                    className="btn-secondary h-8 px-3 text-xs"
                    disabled={!!busy}
                    onClick={() =>
                      void run(`lib-${lib.name}`, "submit the template", async () => {
                        const r = await api<{ status: string }>(`${base}/templates`, { method: "POST", body: { name: lib.name, language: "en" } });
                        await reload();
                        return r.status === "EXISTS" ? "It's already in your account." : `Submitted "${lib.label}" for Meta's review.`;
                      })
                    }
                  >
                    {busy === `lib-${lib.name}` ? "Submitting…" : "Submit for review"}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted">{lib.name} · English</p>
              <div className="mt-3">
                <Bubble
                  text={previewText(lib.body, lib.examples)}
                  buttons={[...(lib.urlButton ? [{ type: "URL", text: lib.urlButton.text }] : []), ...(lib.stopButton ? [{ type: "QUICK_REPLY", text: "Stop promotions" }] : [])]}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
