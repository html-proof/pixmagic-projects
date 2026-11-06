"use client";
import { useMemo, useState } from "react";
import { Modal, Field } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { api, ApiError, fmtNum } from "@/lib/api";
import { newIdempotencyKey, type AdjustmentRow, type LevelView } from "@/lib/inventory";
import {
  ADJUSTMENT_INFO,
  ADJUSTMENT_KINDS,
  ADJUSTMENT_REASON_LABEL,
  ADJUSTMENT_REASONS,
  adjustedQuantity,
  QUANTITY_FIELD,
  QUANTITY_INFO,
  type AdjustmentKind,
} from "@app/shared/inventory";

/** The toast once Shopify confirmed a change: what the stock is now. */
export const confirmedMessage = (a: AdjustmentRow) =>
  `Shopify confirmed the change${a.resultQuantity !== null ? `: ${fmtNum(a.resultQuantity)} ${QUANTITY_INFO[a.quantityName as keyof typeof QUANTITY_INFO]?.label.toLowerCase() ?? ""} now` : ""}.`;

export interface AdjustTarget {
  variantId: string;
  label: string;
  sku: string | null;
  levels: LevelView[];
  /** The location to start on. */
  locationId?: string;
}

/**
 * Change one item's stock at one location, in two steps: what to change, then a confirmation that
 * shows the number before and after. One idempotency key per dialog, so sending again (after
 * "Shopify didn't confirm") never changes stock twice. Done only when Shopify confirmed it.
 */
export function AdjustDialog({ base, target, onClose, onDone }: { base: string; target: AdjustTarget; onClose: () => void; onDone: (a: AdjustmentRow) => void }) {
  const active = target.levels.filter((l) => l.locationActive);
  const [locationId, setLocationId] = useState(target.locationId ?? active[0]?.locationId ?? "");
  const [kind, setKind] = useState<AdjustmentKind>("increase");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<string>(ADJUSTMENT_REASONS.increase[0]!);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The key for this change: a new one whenever what is being changed is edited.
  const [key, setKey] = useState(newIdempotencyKey);
  // What the person saw, frozen when they confirm: Shopify refuses the change if it moved since.
  const [seen, setSeen] = useState<number | null>(null);

  const level = active.find((l) => l.locationId === locationId) ?? null;
  const info = ADJUSTMENT_INFO[kind];
  const current = level ? level[QUANTITY_FIELD[info.checks]] : null;
  const n = Number(quantity);
  const valid = quantity.trim() !== "" && Number.isInteger(n) && (info.mode === "delta" ? n > 0 : info.mode === "signed" ? n !== 0 : n >= 0) && Math.abs(n) <= 1_000_000;
  const after = useMemo(() => (valid && current !== null ? adjustedQuantity({ kind, quantity: n }, current) : null), [valid, current, kind, n]);

  const edit = (f: () => void) => {
    f();
    setKey(newIdempotencyKey());
    setStep("edit");
    setError(null);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ adjustment: AdjustmentRow }>(`${base}/adjustments`, {
        method: "POST",
        body: { idempotencyKey: key, variantId: target.variantId, locationId, kind, quantity: n, expected: seen, reason, note: note || undefined, referenceId: reference || undefined },
      });
      onDone(r.adjustment);
    } catch (e) {
      if (e instanceof ApiError && e.code === "stock_changed") {
        const now = (e.data as { detail?: { current?: number } } | undefined)?.detail?.current;
        setError(`The stock changed in Shopify since you looked${now !== undefined ? `: it's ${fmtNum(now)} now` : ""}. Check the number and confirm again.`);
        if (now !== undefined) setSeen(now);
        setKey(newIdempotencyKey());
      } else if (e instanceof ApiError && e.code === "unconfirmed") {
        // Same key: sending again is safe, Shopify applies it at most once.
        setError("Shopify didn't confirm the change, so nothing is shown as changed. Confirm again to retry: it won't be made twice.");
      } else {
        setError(e instanceof ApiError ? e.message : "The change couldn't be sent. Nothing was changed.");
        if (e instanceof ApiError && e.status < 500) setKey(newIdempotencyKey());
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open title={`Adjust stock: ${target.label}`} onClose={busy ? () => undefined : onClose} wide>
      {active.length === 0 ? (
        <p className="text-sm text-muted">This item isn&apos;t stocked at any active location in Shopify. Add it to a location in Shopify first.</p>
      ) : step === "edit" ? (
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setSeen(current);
            setStep("confirm");
          }}
        >
          <Field label="Location" htmlFor="adj-location">
            <select id="adj-location" className="input" value={locationId} onChange={(e) => edit(() => setLocationId(e.target.value))}>
              {active.map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.locationName} ({fmtNum(l.available)} available)
                </option>
              ))}
            </select>
          </Field>
          <Field label="Change" htmlFor="adj-kind" hint={info.description}>
            <select
              id="adj-kind"
              className="input"
              value={kind}
              onChange={(e) =>
                edit(() => {
                  const k = e.target.value as AdjustmentKind;
                  setKind(k);
                  setReason(ADJUSTMENT_REASONS[k][0]!);
                })
              }
            >
              {ADJUSTMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {ADJUSTMENT_INFO[k].label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={info.mode === "absolute" ? (kind === "stocktake" ? "Units counted" : "New quantity") : info.mode === "signed" ? "Correction (+ or −)" : "Units"}
            htmlFor="adj-qty"
            hint={current === null ? undefined : `${QUANTITY_INFO[info.checks].label} now: ${fmtNum(current)}`}
            required
          >
            <input id="adj-qty" className="input" inputMode="numeric" value={quantity} onChange={(e) => edit(() => setQuantity(e.target.value.trim()))} placeholder={info.mode === "signed" ? "e.g. -2" : "e.g. 5"} />
          </Field>
          <Field label="Reason" htmlFor="adj-reason">
            <select id="adj-reason" className="input" value={reason} onChange={(e) => edit(() => setReason(e.target.value))} disabled={ADJUSTMENT_REASONS[kind].length === 1}>
              {ADJUSTMENT_REASONS[kind].map((r) => (
                <option key={r} value={r}>
                  {ADJUSTMENT_REASON_LABEL[r] ?? r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" htmlFor="adj-note" hint="Kept with the change in the stock history.">
            <input id="adj-note" className="input" maxLength={500} value={note} onChange={(e) => edit(() => setNote(e.target.value))} />
          </Field>
          <Field label="Reference" htmlFor="adj-ref" hint="A purchase order, transfer or count number.">
            <input id="adj-ref" className="input" maxLength={100} value={reference} onChange={(e) => edit(() => setReference(e.target.value))} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!valid}>
              Review change
            </button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="rounded bg-home-soft p-4">
            <p className="text-sm text-muted">
              {level?.locationName} · {target.sku ? `SKU ${target.sku} · ` : ""}
              {ADJUSTMENT_INFO[kind].label} · {ADJUSTMENT_REASON_LABEL[reason] ?? reason}
            </p>
            <p className="mt-2 text-2xl font-semibold tabular-nums" data-testid="adjust-preview">
              {QUANTITY_INFO[info.checks].label}: {fmtNum(seen)} → {fmtNum(after === null || seen === null ? null : adjustedQuantity({ kind, quantity: n }, seen))}
            </p>
            {kind === "damaged" && <p className="mt-1 text-sm text-muted">{fmtNum(n)} units move to damaged: they stay on hand but can&apos;t be sold.</p>}
            {kind === "stocktake" && <p className="mt-1 text-sm text-muted">Shopify sets what&apos;s on hand to the units counted; available changes by the same amount.</p>}
          </div>
          <p className="text-sm text-muted">This changes the stock in Shopify, where your store sells from. It&apos;s shown as done once Shopify confirms it.</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setStep("edit")} disabled={busy}>
              Back
            </button>
            <button type="button" className="btn-primary" onClick={send} disabled={busy} data-testid="adjust-confirm">
              {busy ? "Waiting for Shopify…" : "Confirm change"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
