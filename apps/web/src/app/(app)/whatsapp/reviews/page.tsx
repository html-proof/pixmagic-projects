"use client";
import { useState } from "react";
import { kindsOf, MODERATION_LABEL, MODERATION_REASONS, type ModerationReason } from "@app/shared/whatsapp";
import { Badge, Empty, Stat, type Tone } from "@/components/dashboard/primitives";
import { useApp } from "@/components/AppContext";
import { api, fmtNum, useApi } from "@/lib/api";
import { fmtWhen, KindsSection, PageHeader, useAction, useWa } from "@/components/whatsapp/common";

interface Review {
  id: string;
  orderName: string;
  productTitle: string | null;
  rating: number;
  body: string | null;
  reviewerName: string | null;
  status: "pending" | "published" | "rejected";
  moderationReason: ModerationReason | null;
  submittedAt: string;
  editedAt: string | null;
}
interface ReviewsResponse {
  summary: {
    average: number | null;
    counted: number;
    byStatus: Record<string, number>;
    distribution: Array<{ rating: number; count: number }>;
    rejectedByRating: Array<{ rating: number; count: number }>;
  };
  reviews: Review[];
  nextCursor: string | null;
}

const STATUS: Record<Review["status"], { tone: Tone; label: string }> = {
  pending: { tone: "neutral", label: "Waiting for you" },
  published: { tone: "good", label: "Published" },
  rejected: { tone: "danger", label: "Removed" },
};

const Stars = ({ n, label }: { n: number; label?: string }) => (
  <span role="img" aria-label={label ?? `${n} out of 5 stars`} className="tracking-tight text-[#e3a008]">
    {"★".repeat(n)}
    <span className="text-muted/45">{"★".repeat(5 - n)}</span>
  </span>
);

function Moderate({ r, onDone }: { r: Review; onDone: () => void }) {
  const { base } = useWa();
  const { busy, run } = useAction();
  const [reason, setReason] = useState<ModerationReason | "">("");
  const set = (status: Review["status"], why?: ModerationReason) =>
    run(`${r.id}-${status}`, "update the review", async () => {
      await api(`${base}/reviews/${r.id}`, { method: "PATCH", body: { status, ...(why ? { reason: why } : {}) } });
      onDone();
      return status === "published" ? "Published." : status === "rejected" ? "Removed." : "Held for later.";
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {r.status !== "published" && (
        <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void set("published")}>Publish</button>
      )}
      {r.status === "published" && (
        <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void set("pending")}>Unpublish</button>
      )}
      {r.status !== "rejected" && (
        <>
          <label className="sr-only" htmlFor={`why-${r.id}`}>Reason to remove</label>
          <select id={`why-${r.id}`} className="input h-8 w-auto py-0 text-xs" value={reason} onChange={(e) => setReason(e.target.value as ModerationReason)}>
            <option value="">Remove because…</option>
            {MODERATION_REASONS.map((m) => (
              <option key={m} value={m}>{MODERATION_LABEL[m]}</option>
            ))}
          </select>
          <button type="button" className="btn-danger h-8 px-3 text-xs" disabled={!!busy || !reason} onClick={() => reason && void set("rejected", reason)}>Remove</button>
        </>
      )}
    </div>
  );
}

export default function Reviews() {
  const { base, contact, manage, store } = useWa();
  const app = useApp();
  const [status, setStatus] = useState<string>("pending");
  const { data, error, reload } = useApi<ReviewsResponse>(contact && base ? `${base}/reviews?${new URLSearchParams({ limit: "50", ...(status ? { status } : {}) })}` : null);
  const s = data?.summary;
  const max = Math.max(1, ...(s?.distribution.map((d) => d.count) ?? [1]));
  const rejectedLow = (s?.rejectedByRating ?? []).filter((r) => r.rating <= 2).reduce((n, r) => n + r.count, 0);
  const feed = typeof window !== "undefined" && store ? `${window.location.origin}/api/public/stores/${store.id}/reviews` : "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer reviews"
        sub="A few days after a confirmed delivery, customers get a link to rate their order and each product. Every review is tied to a real order, one per product (customers can edit theirs). Positive or negative, honest feedback is welcome: reviews are never paid for or rewarded."
      />

      <KindsSection
        title="Review requests"
        kinds={kindsOf("reviews")}
        extra={(cfg, set) => (
          <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="rv-d">Ask this many days after delivery</label>
              <input id="rv-d" type="number" min={0} max={60} className="input" disabled={!manage} value={cfg.reviewDelayDays} onChange={(e) => set({ ...cfg, reviewDelayDays: Number(e.target.value) })} />
            </div>
            <div>
              <label className="label" htmlFor="rv-r">Remind once, after (days)</label>
              <input id="rv-r" type="number" min={1} max={30} className="input" disabled={!manage} value={cfg.reviewReminderDays} onChange={(e) => set({ ...cfg, reviewReminderDays: Number(e.target.value) })} />
              <p className="mt-1 text-xs text-muted">Only if no review came in. Never more than once.</p>
            </div>
            <label className="flex items-start gap-2 text-sm sm:mt-6">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" disabled={!manage} checked={cfg.reviewAutoPublish} onChange={(e) => set({ ...cfg, reviewAutoPublish: e.target.checked })} />
              <span>Publish new reviews straight away (you can still remove abusive ones)</span>
            </label>
            <p className="text-xs text-muted sm:col-span-3">Don&apos;t offer discounts or gifts for reviews: incentives for positive reviews break consumer law in many countries and WhatsApp&apos;s policies.</p>
          </div>
        )}
      />

      {!contact ? (
        <div className="card text-sm text-muted">Your role can&apos;t see customers&apos; reviews. Ask an owner or admin.</div>
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-[16rem_1fr]" aria-label="Ratings">
            <Stat label="Average rating" value={s?.average ? `${s.average} / 5` : "—"} note={s ? `${fmtNum(s.counted)} review${s.counted === 1 ? "" : "s"} (published and waiting)` : undefined} />
            <div className="card">
              <p className="text-xs text-muted">Rating distribution</p>
              <ul className="mt-2 space-y-1">
                {[5, 4, 3, 2, 1].map((r) => {
                  const c = s?.distribution.find((d) => d.rating === r)?.count ?? 0;
                  return (
                    <li key={r} className="flex items-center gap-2 text-sm">
                      <span className="w-10 shrink-0">{r} ★</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-border/60">
                        <span className="block h-full rounded-full bg-[#e3a008]" style={{ width: `${(c / max) * 100}%` }} />
                      </span>
                      <span className="w-8 text-right tabular-nums text-muted">{c}</span>
                    </li>
                  );
                })}
              </ul>
              {rejectedLow > 0 && (
                <p className="mt-2 text-xs text-warn">
                  {rejectedLow} removed review{rejectedLow === 1 ? " was" : "s were"} rated 1 or 2 stars. Remove reviews only for the reasons listed, never for being negative.
                </p>
              )}
            </div>
          </section>

          <section className="card animate-rise" aria-labelledby="rv-h">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="rv-h" className="font-semibold">Reviews</h2>
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter">
                {([["pending", `Waiting (${s?.byStatus.pending ?? 0})`], ["published", `Published (${s?.byStatus.published ?? 0})`], ["rejected", `Removed (${s?.byStatus.rejected ?? 0})`], ["", "All"]] as const).map(([v, label]) => (
                  <button key={v} type="button" role="tab" aria-selected={status === v} className={`rounded-full px-3 py-1 text-sm ${status === v ? "bg-accent/12 font-semibold text-accent" : "text-muted hover:text-text"}`} onClick={() => setStatus(v)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {error ? (
              <p className="mt-3 text-sm text-danger">{error.message}</p>
            ) : !data ? (
              <div className="mt-3 space-y-2">{[0, 1].map((i) => <div key={i} className="skeleton h-16" />)}</div>
            ) : !data.reviews.length ? (
              <div className="mt-3"><Empty>No reviews here yet.</Empty></div>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {data.reviews.map((r) => (
                  <li key={r.id} className="space-y-2 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Stars n={r.rating} />
                      <span className="font-medium">{r.productTitle ?? "The order overall"}</span>
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    </div>
                    {r.body ? <p className="whitespace-pre-wrap text-sm">{r.body}</p> : <p className="text-sm italic text-muted">No written comment.</p>}
                    <p className="text-xs text-muted">
                      {r.reviewerName || "Anonymous"} · order {r.orderName} · {fmtWhen(r.submittedAt, app.store?.timezone)}
                      {r.editedAt ? " · edited" : ""}
                      {r.moderationReason ? ` · removed: ${MODERATION_LABEL[r.moderationReason]}` : ""}
                    </p>
                    {manage && <Moderate r={r} onDone={() => void reload()} />}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {feed && (
            <section className="card text-sm text-muted">
              <h2 className="font-semibold text-text">Show published reviews on your store</h2>
              <p className="mt-1">Published reviews are available as a public feed your theme can read (newest 50, with the average). Add <code>?productId=</code> with a Shopify product id for one product.</p>
              <code className="mt-2 block truncate rounded-md border border-border bg-bg px-2 py-1.5 text-xs" title={feed}>{feed}</code>
            </section>
          )}
        </>
      )}
    </div>
  );
}
