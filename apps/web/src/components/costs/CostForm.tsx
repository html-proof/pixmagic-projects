"use client";
import {
  categoriesOf,
  EXPENSE_CADENCE_LABEL,
  EXPENSE_CADENCES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_GROUP_LABEL,
  EXPENSE_GROUPS,
  type Expense,
  type ExpenseCadence,
  type ExpenseCategory,
  type ExpenseInput,
} from "@app/shared/expenses";
import { fmtDay } from "@/components/dashboard/format";
import { fmtMoney } from "@/lib/api";

// ---------------------------------------------------------------------------
// One of the store's costs as the owner types it in: Settings → Costs and the Profit sheet's
// profit and loss both edit costs with these fields, and the API checks the same rules
// (expenseInput in @app/shared/expenses).
// ---------------------------------------------------------------------------

export type CostDraft = { name: string; category: ExpenseCategory; amount: string; cadence: ExpenseCadence; startsOn: string; endsOn: string; note: string };

/** A new cost: by default monthly from the first of `today`'s month (a cost paid once, on `today`). */
export const blankCost = (today: string, category: ExpenseCategory = "shopify_apps", cadence: ExpenseCadence = "monthly"): CostDraft => ({
  name: "",
  category,
  amount: "",
  cadence,
  startsOn: cadence === "once" ? today : `${today.slice(0, 8)}01`,
  endsOn: "",
  note: "",
});
export const draftOf = (e: Expense): CostDraft => ({ name: e.name, category: e.category, amount: String(e.amount), cadence: e.cadence, startsOn: e.startsOn, endsOn: e.endsOn ?? "", note: e.note ?? "" });
export const inputOf = (d: CostDraft): ExpenseInput => ({
  name: d.name,
  category: d.category,
  amount: Number(d.amount),
  cadence: d.cadence,
  startsOn: d.startsOn,
  endsOn: d.cadence === "once" || !d.endsOn ? null : d.endsOn,
  note: d.note.trim() ? d.note : null,
});

/** "A$39.00 every month", "A$250.00 once". */
export const termsOf = (e: Pick<Expense, "amount" | "cadence">, currency: string) => `${fmtMoney(e.amount, currency)} ${EXPENSE_CADENCE_LABEL[e.cadence].toLowerCase()}`;

/** "From 1 Oct 2026", "1 Oct – 31 Dec 2026", "On 5 Oct 2026". */
export function whenOf(e: Pick<Expense, "cadence" | "startsOn" | "endsOn">) {
  if (e.cadence === "once") return `On ${fmtDay(e.startsOn)}`;
  return e.endsOn ? `${fmtDay(e.startsOn)} – ${fmtDay(e.endsOn)}` : `From ${fmtDay(e.startsOn)}`;
}

/** The cost's fields, two to a row from a tablet up; the caller keeps the form and its buttons. */
export function CostFields({ draft, currency, set }: { draft: CostDraft; currency: string; set: (patch: Partial<CostDraft>) => void }) {
  return (
    <>
      <label className="space-y-1 sm:col-span-2">
        <span className="label">Name</span>
        <input className="input" required maxLength={80} placeholder="e.g. Shop rent, Shopify Basic, packing tape" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="space-y-1">
        <span className="label">What it is for</span>
        <select className="input" value={draft.category} onChange={(e) => set({ category: e.target.value as ExpenseCategory })}>
          {EXPENSE_GROUPS.map((g) => (
            <optgroup key={g} label={EXPENSE_GROUP_LABEL[g]}>
              {categoriesOf(g).map((c) => (
                <option key={c} value={c}>
                  {EXPENSE_CATEGORY_LABEL[c]}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="label">Amount ({currency})</span>
        <input className="input" required type="number" inputMode="decimal" min={0} step="0.01" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} />
      </label>
      <label className="space-y-1">
        <span className="label">How often</span>
        <select className="input" value={draft.cadence} onChange={(e) => set({ cadence: e.target.value as ExpenseCadence })}>
          {EXPENSE_CADENCES.map((c) => (
            <option key={c} value={c}>
              {EXPENSE_CADENCE_LABEL[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="label">{draft.cadence === "once" ? "Paid on" : "Starts on"}</span>
        <input className="input" required type="date" value={draft.startsOn} onChange={(e) => set({ startsOn: e.target.value })} />
      </label>
      {draft.cadence !== "once" && (
        <label className="space-y-1">
          <span className="label">Ends on (optional)</span>
          <input className="input" type="date" min={draft.startsOn} value={draft.endsOn} onChange={(e) => set({ endsOn: e.target.value })} />
        </label>
      )}
      <label className="space-y-1 sm:col-span-2">
        <span className="label">Note (optional)</span>
        <input className="input" maxLength={500} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </label>
    </>
  );
}
