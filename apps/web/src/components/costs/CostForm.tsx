"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  categoriesIn,
  categoryLabel,
  categorySection,
  customCategoryKey,
  EXPENSE_CADENCE_LABEL,
  EXPENSE_CADENCES,
  EXPENSE_CATEGORY_LABEL,
  EXPENSE_METHOD_LABEL,
  EXPENSE_METHODS,
  EXPENSE_SECTION_LABEL,
  EXPENSE_SECTIONS,
  PERCENT_BASE_LABEL,
  PERCENT_BASES,
  type CustomCategory,
  type Expense,
  type ExpenseCadence,
  type ExpenseMethod,
  type ExpenseSection,
  type ExpenseInputSent,
  type PercentBase,
} from "@app/shared/expenses";
import { fmtDay } from "@/components/dashboard/format";
import { fmtMoney } from "@/lib/api";

// ---------------------------------------------------------------------------
// One of the store's costs as the owner types it in: Profit & Loss, Settings → Costs and the Profit
// sheet all edit costs with these fields, and the API checks the same rules (expenseInput in
// @app/shared/expenses). Every field a cost has is here, so saving it from any page keeps them all.
// ---------------------------------------------------------------------------

export type CostDraft = {
  name: string;
  description: string;
  section: ExpenseSection;
  category: string;
  method: ExpenseMethod;
  amount: string;
  percentBase: PercentBase;
  cadence: ExpenseCadence;
  startsOn: string;
  endsOn: string;
  vendor: string;
  paymentMethod: string;
  note: string;
};

/** A new cost: by default monthly from the first of `today`'s month (a cost paid once, on `today`). */
export const blankCost = (today: string, category = "shopify_apps", cadence: ExpenseCadence = "monthly", method: ExpenseMethod = "amount"): CostDraft => ({
  name: "",
  description: "",
  section: categorySection(category) ?? "fixed",
  category,
  method,
  amount: "",
  percentBase: "total_sales",
  cadence: method === "amount" ? cadence : "daily",
  startsOn: cadence === "once" || cadence === "daily" ? today : `${today.slice(0, 8)}01`,
  endsOn: "",
  vendor: "",
  paymentMethod: "",
  note: "",
});

export const draftOf = (e: Expense, customs: readonly CustomCategory[] = []): CostDraft => ({
  name: e.name,
  description: e.description ?? "",
  section: categorySection(e.category, customs) ?? "fixed",
  category: e.category,
  method: e.method ?? "amount",
  amount: String(e.amount),
  percentBase: e.percentBase ?? "total_sales",
  cadence: e.cadence,
  startsOn: e.startsOn,
  endsOn: e.endsOn ?? "",
  vendor: e.vendor ?? "",
  paymentMethod: e.paymentMethod ?? "",
  note: e.note ?? "",
});

/** A copy of a cost (the costs list's Duplicate): its terms, a name that says so, from `today`. */
export const copyOf = (e: Expense, today: string, customs: readonly CustomCategory[] = []): CostDraft => ({ ...draftOf(e, customs), name: `${e.name} (copy)`.slice(0, 80), startsOn: today, endsOn: "" });

export const inputOf = (d: CostDraft, currency: string): ExpenseInputSent => {
  const once = d.method === "amount" && d.cadence === "once";
  return {
    name: d.name,
    description: d.description.trim() ? d.description : null,
    category: d.category,
    method: d.method,
    amount: Number(d.amount),
    percentBase: d.method === "percent" ? d.percentBase : null,
    currency,
    cadence: d.method === "amount" ? d.cadence : "daily",
    startsOn: d.startsOn,
    endsOn: once || !d.endsOn ? null : d.endsOn,
    vendor: d.vendor.trim() ? d.vendor : null,
    paymentMethod: d.paymentMethod.trim() ? d.paymentMethod : null,
    note: d.note.trim() ? d.note : null,
  };
};

/** Whether a cost is paid every day, week, month… (the ones with payments, that can be paused). */
export const isRecurring = (e: Pick<Expense, "method" | "cadence">) => (e.method ?? "amount") === "amount" && e.cadence !== "once";

/** "A$39.00 every month", "A$250.00 once", "2% of total sales (tax included)", "A$20.00 per order". */
export function termsOf(e: Pick<Expense, "amount" | "cadence"> & Partial<Pick<Expense, "method" | "percentBase">>, currency: string): string {
  switch (e.method ?? "amount") {
    case "percent":
      return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(e.amount)}% of ${PERCENT_BASE_LABEL[e.percentBase ?? "total_sales"].toLowerCase()}`;
    case "per_order":
      return `${fmtMoney(e.amount, currency)} per order`;
    case "per_item":
      return `${fmtMoney(e.amount, currency)} per item sold`;
    default:
      return `${fmtMoney(e.amount, currency)} ${EXPENSE_CADENCE_LABEL[e.cadence].toLowerCase()}`;
  }
}

/** "From 1 Oct 2026", "1 Oct – 31 Dec 2026", "On 5 Oct 2026". */
export function whenOf(e: Pick<Expense, "cadence" | "startsOn" | "endsOn"> & Partial<Pick<Expense, "method">>) {
  if ((e.method ?? "amount") === "amount" && e.cadence === "once") return `On ${fmtDay(e.startsOn)}`;
  return e.endsOn ? `${fmtDay(e.startsOn)} – ${fmtDay(e.endsOn)}` : `From ${fmtDay(e.startsOn)}`;
}

/** The categories offered for a section: the built-in ones, then the store's own. */
function categoryOptions(section: ExpenseSection, customs: readonly CustomCategory[]) {
  return [
    ...categoriesIn(section).map((c) => ({ key: c as string, label: EXPENSE_CATEGORY_LABEL[c] })),
    ...customs.filter((c) => c.section === section).map((c) => ({ key: customCategoryKey(c.id), label: c.name })),
  ];
}

/** What to say beside a category, where a cost could be counted twice. */
const CATEGORY_HINT: Partial<Record<string, string>> = {
  marketing: "Spend in the Meta Ads and Google Ads accounts connected to bizinsights is already counted: add only ads paid elsewhere (TikTok, influencers, print…).",
  ad_spend_adjustment: "Changes the synced ad spend without touching it: a positive amount adds to it, below 0 takes off (a credit from the platform). Paid once.",
  product_cost_adjustment: "Changes Shopify's product costs without touching them: a positive amount adds to them, below 0 takes off. Each product's cost per item in Shopify is already counted.",
  payment_fees: "Shopify Payments' fees aren't read from Shopify: add them here, as a percentage of sales or an amount per order.",
};

const PAYMENT_METHODS = ["Card", "Bank transfer", "Direct debit", "PayPal", "Cash", "Shopify bill"];

/**
 * The cost's fields, two to a row from a tablet up; the caller keeps the form and its buttons.
 * `onCreateCategory`: makes a category of the store's own and returns it (null when it couldn't);
 * without it, the store's categories are offered but no new one.
 */
export function CostFields({
  draft,
  currency,
  set,
  categories = [],
  onCreateCategory,
}: {
  draft: CostDraft;
  currency: string;
  set: (patch: Partial<CostDraft>) => void;
  categories?: readonly CustomCategory[];
  onCreateCategory?: (name: string, section: ExpenseSection) => Promise<CustomCategory | null>;
}) {
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const options = categoryOptions(draft.section, categories);
  const once = draft.method === "amount" && draft.cadence === "once";
  const amountLabel = draft.method === "percent" ? "Percentage (%)" : draft.method === "per_order" ? `Amount per order (${currency})` : draft.method === "per_item" ? `Amount per item (${currency})` : `Amount (${currency})`;
  const hint = CATEGORY_HINT[draft.category];

  const pickSection = (section: ExpenseSection) => {
    const first = categoryOptions(section, categories)[0]?.key ?? draft.category;
    set({ section, category: categorySection(draft.category, categories) === section ? draft.category : first });
  };
  async function create() {
    if (!onCreateCategory || !newName?.trim()) return;
    setCreating(true);
    const made = await onCreateCategory(newName.trim(), draft.section);
    setCreating(false);
    if (made) {
      set({ category: customCategoryKey(made.id) });
      setNewName(null);
    }
  }

  return (
    <>
      <label className="space-y-1 sm:col-span-2">
        <span className="label">Expense name</span>
        <input className="input" required maxLength={80} placeholder="e.g. Shop rent, Shopify Basic, packing boxes" value={draft.name} onChange={(e) => set({ name: e.target.value })} data-testid="cost-name" />
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className="label">Description (optional)</span>
        <input className="input" maxLength={500} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
      </label>

      <fieldset className="space-y-1 sm:col-span-2">
        <legend className="label">Cost type</legend>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Cost type">
          {EXPENSE_SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={draft.section === s}
              className={`h-9 rounded-lg border px-3 text-sm font-medium transition ${draft.section === s ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`}
              onClick={() => pickSection(s)}
              data-testid={`cost-section-${s}`}
            >
              {EXPENSE_SECTION_LABEL[s]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="space-y-1 sm:col-span-2">
        <label className="space-y-1">
          <span className="label">Category</span>
          <select
            className="input"
            value={newName !== null ? "__new__" : draft.category}
            onChange={(e) => {
              if (e.target.value === "__new__") setNewName("");
              else {
                setNewName(null);
                set({ category: e.target.value });
              }
            }}
            data-testid="cost-category"
          >
            {!options.some((o) => o.key === draft.category) && <option value={draft.category}>{categoryLabel(draft.category, categories)}</option>}
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
            {onCreateCategory && <option value="__new__">+ New category…</option>}
          </select>
        </label>
        {newName !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input h-9 w-auto min-w-0 flex-1"
              autoFocus
              maxLength={60}
              placeholder={`A new ${EXPENSE_SECTION_LABEL[draft.section].toLowerCase().replace(/ costs$/, "")} category`}
              aria-label="New category's name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              data-testid="cost-new-category"
            />
            <button type="button" className="btn-secondary h-9 gap-1 px-3 text-sm" disabled={creating || !newName.trim()} onClick={create}>
              <Plus aria-hidden className="h-4 w-4" />
              {creating ? "Adding…" : "Add category"}
            </button>
            <button type="button" className="h-9 px-2 text-sm text-muted hover:text-text" onClick={() => setNewName(null)}>
              Cancel
            </button>
          </div>
        )}
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>

      <fieldset className="space-y-1 sm:col-span-2">
        <legend className="label">Calculation method</legend>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Calculation method">
          {EXPENSE_METHODS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={draft.method === m}
              className={`h-9 rounded-lg border px-3 text-sm font-medium transition ${draft.method === m ? "border-accent bg-accent/12 text-accent" : "border-border text-muted hover:text-text"}`}
              onClick={() => set({ method: m, cadence: m === "amount" ? (draft.cadence === "daily" ? "monthly" : draft.cadence) : "daily" })}
              data-testid={`cost-method-${m}`}
            >
              {EXPENSE_METHOD_LABEL[m]}
            </button>
          ))}
        </div>
        {draft.method !== "amount" && <p className="text-xs text-muted">Worked out from each day&apos;s sales, from its start date to its end date (a day whose refunds outweigh its sales carries none).</p>}
      </fieldset>

      <label className="space-y-1">
        <span className="label">{amountLabel}</span>
        <input
          className="input"
          required
          type="number"
          inputMode="decimal"
          min={once ? undefined : draft.method === "percent" ? 0.01 : 0}
          max={draft.method === "percent" ? 100 : undefined}
          step="0.01"
          value={draft.amount}
          onChange={(e) => set({ amount: e.target.value })}
          data-testid="cost-amount"
        />
        {once && <span className="block text-xs text-muted">Below 0 for a refund or a credit.</span>}
      </label>
      {draft.method === "percent" ? (
        <label className="space-y-1">
          <span className="label">Percentage of</span>
          <select className="input" value={draft.percentBase} onChange={(e) => set({ percentBase: e.target.value as PercentBase })} data-testid="cost-percent-base">
            {PERCENT_BASES.map((b) => (
              <option key={b} value={b}>
                {PERCENT_BASE_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="space-y-1">
          <span className="label">Currency</span>
          <input className="input" readOnly value={currency} aria-describedby="cost-currency-note" />
          <span id="cost-currency-note" className="block text-xs text-muted">
            The store&apos;s currency: costs are kept in it, never converted.
          </span>
        </label>
      )}

      {draft.method === "amount" && (
        <label className="space-y-1">
          <span className="label">Payment frequency</span>
          <select className="input" value={draft.cadence} onChange={(e) => set({ cadence: e.target.value as ExpenseCadence })} data-testid="cost-cadence">
            {EXPENSE_CADENCES.map((c) => (
              <option key={c} value={c}>
                {c === "once" ? "One-time" : EXPENSE_CADENCE_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="space-y-1">
        <span className="label">{once ? "Expense date" : draft.method === "amount" ? "First payment (start date)" : "Start date"}</span>
        <input className="input" required type="date" value={draft.startsOn} onChange={(e) => set({ startsOn: e.target.value })} data-testid="cost-starts" />
      </label>
      {!once && (
        <label className="space-y-1">
          <span className="label">End date (optional)</span>
          <input className="input" type="date" min={draft.startsOn} value={draft.endsOn} onChange={(e) => set({ endsOn: e.target.value })} data-testid="cost-ends" />
        </label>
      )}

      <label className="space-y-1">
        <span className="label">Vendor or supplier (optional)</span>
        <input className="input" maxLength={80} value={draft.vendor} onChange={(e) => set({ vendor: e.target.value })} />
      </label>
      <label className="space-y-1">
        <span className="label">Payment method (optional)</span>
        <input className="input" maxLength={40} list="cost-payment-methods" value={draft.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })} />
        <datalist id="cost-payment-methods">
          {PAYMENT_METHODS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label className="space-y-1 sm:col-span-2">
        <span className="label">Notes (optional)</span>
        <input className="input" maxLength={500} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </label>
    </>
  );
}

/** Whether a change to this cost asks how far back it goes: a recurring amount whose first payment has fallen due. */
export const asksApplyFrom = (e: Expense | null | undefined, today: string) => !!e && isRecurring(e) && e.startsOn <= today;

/** Whether a draft changes what a recurring cost's payments are (its amount, how often, its start, how it's worked out). */
export const changesPayments = (e: Expense, d: CostDraft) =>
  Number(d.amount) !== e.amount || d.cadence !== e.cadence || d.startsOn !== e.startsOn || d.method !== (e.method ?? "amount") || (d.method === "percent" && d.percentBase !== e.percentBase);

/**
 * How far back a change to a recurring cost goes: from its next payment (the payments already made
 * stay as they were, so no month already reported changes), or every payment, past ones too.
 */
export function ApplyChoice({ value, onChange, next }: { value: "next" | "all"; onChange: (v: "next" | "all") => void; next: string | null }) {
  return (
    <fieldset className="space-y-1 rounded-lg border border-border bg-bg/50 p-3 text-sm sm:col-span-2" data-testid="cost-apply">
      <legend className="label px-1">Apply the change</legend>
      <label className="flex items-start gap-2">
        <input type="radio" name="apply" className="mt-1" checked={value === "next"} onChange={() => onChange("next")} />
        <span>
          From the next payment{next ? ` (${fmtDay(next)})` : ""}
          <span className="block text-xs text-muted">The payments already made stay as they were: no month already reported changes.</span>
        </span>
      </label>
      <label className="flex items-start gap-2">
        <input type="radio" name="apply" className="mt-1" checked={value === "all"} onChange={() => onChange("all")} />
        <span>
          To every payment, past ones too
          <span className="block text-xs text-muted">Reports for months already past change. A payment you changed one by one keeps its own amount.</span>
        </span>
      </label>
    </fieldset>
  );
}
