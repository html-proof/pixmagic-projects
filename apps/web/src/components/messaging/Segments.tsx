"use client";
import { useState } from "react";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
import { TableCard } from "@/components/automations/MarketingKit";
import { Empty } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { fmtWhen, smsError, useSms, useSmsAction } from "./MessagingUi";
import { blankFilter, fromFilter, parseFilter, SegmentFilterFields, SegmentReach, type FilterDraft } from "./SegmentFilter";
import type { SmsSegment } from "./types";

function Editor({ segment, onDone }: { segment: SmsSegment | null; onDone: (saved: boolean) => void }) {
  const { base, store } = useSms();
  const toast = useToast();
  const [name, setName] = useState(segment?.name ?? "");
  const [draft, setDraft] = useState<FilterDraft>(segment ? fromFilter(segment.filter) : blankFilter());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!base) return null;
  const parsed = parseFilter(draft);
  const save = async () => {
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      await api(segment ? `${base}/segments/${segment.id}` : `${base}/segments`, { method: segment ? "PUT" : "POST", body: { name: name.trim(), filter: parsed.filter } });
      toast("success", "Segment saved.");
      onDone(true);
    } catch (e) {
      setError(smsError(e, "save the segment"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card id="seg-ed" title={segment ? `Edit “${segment.name}”` : "New segment"}>
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-3">
          <div className="max-w-sm">
            <label className="label" htmlFor="seg-name">
              Name
            </label>
            <input id="seg-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Repeat buyers in Australia" />
          </div>
          <SegmentFilterFields value={draft} onChange={setDraft} currency={store?.currency} />
        </div>
        <SegmentReach base={base} draft={draft} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-home-line pt-4">
        <button type="button" className="btn-primary" disabled={busy || !name.trim() || !parsed.ok} onClick={() => void save()}>
          {busy ? "Saving…" : "Save segment"}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </Card>
  );
}

/**
 * Customer Segments: saved audiences for campaigns, always within customers who agreed to SMS
 * marketing. The list is the Stitch design's screen 16 card of rows: each segment, who it holds in
 * words, and how many customers it reaches now (the API's count).
 */
export function CustomerSegments() {
  const { base, manage, store } = useSms();
  const { data, error, reload, loading } = useApi<{ segments: SmsSegment[] }>(base ? `${base}/segments` : null);
  const [editing, setEditing] = useState<{ segment: SmsSegment | null; key: number } | null>(null);
  const [deleting, setDeleting] = useState<SmsSegment | null>(null);
  const { busy, run } = useSmsAction();
  return (
    <div className="space-y-4">
      <PageHeader
        title="Customer Segments"
        sub="Save the audiences you text most: by country, orders, spend or how recently they bought. A segment only ever includes customers subscribed to your SMS marketing in Shopify who haven't opted out; a phone number or a past purchase is never taken as agreement."
        actions={
          manage && !editing ? (
            <button type="button" className="btn-primary" onClick={() => setEditing({ segment: null, key: Date.now() })}>
              New segment
            </button>
          ) : undefined
        }
      />
      {editing && (
        <Editor
          key={editing.key}
          segment={editing.segment}
          onDone={(saved) => {
            setEditing(null);
            if (saved) void reload();
          }}
        />
      )}
      {error ? (
        <LoadError what="your segments" error={error} onRetry={() => void reload()} busy={loading} />
      ) : !data ? (
        <Skeleton lines={3} />
      ) : !data.segments.length ? (
        !editing && <Empty>No segments yet. Campaigns can also use a one-off audience.</Empty>
      ) : (
        <TableCard id="seg-list" title="Segments">
          <ul className="divide-y divide-home-line border-t border-home-line">
            {data.segments.map((s) => (
              <li key={s.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 sm:px-6">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{s.name}</p>
                  <p className="text-sm text-muted">{s.description}</p>
                  <p className="mt-0.5 text-xs text-muted">Updated {fmtWhen(s.updatedAt, store?.timezone)}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold tabular-nums">{fmtNum(s.recipients)}</p>
                  <p className="text-xs text-muted">customer{s.recipients === 1 ? "" : "s"} now</p>
                </div>
                {manage && (
                  <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                    <button type="button" className="home-btn h-8" onClick={() => setEditing({ segment: s, key: Date.now() })} aria-label={`Edit ${s.name}`}>
                      Edit
                    </button>
                    <button type="button" className="home-btn h-8 hover:text-danger" disabled={!!busy} onClick={() => setDeleting(s)} aria-label={`Delete ${s.name}`}>
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </TableCard>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={`Delete "${deleting?.name ?? ""}"?`}
        confirmLabel="Delete"
        danger
        busy={!!busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          void run("delete", "delete the segment", async () => {
            await api(`${base}/segments/${deleting!.id}`, { method: "DELETE" });
            setDeleting(null);
            await reload();
            return "Segment deleted.";
          })
        }
      >
        <p>Campaigns that already finished keep their results. A campaign still using it has to be finished or cancelled first.</p>
      </ConfirmDialog>
    </div>
  );
}
