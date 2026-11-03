"use client";
import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { EXPENSE_SECTION_LABEL, EXPENSE_SECTIONS, MAX_CUSTOM_CATEGORIES, type CustomCategory, type ExpenseSection } from "@app/shared/expenses";
import { ConfirmDialog, Dialog, useAction } from "@/components/AppUi";
import { ApplyChoice, asksApplyFrom, changesPayments, CostFields, inputOf, type CostDraft } from "@/components/costs/CostForm";
import { api } from "@/lib/api";
import type { ListedExpense } from "./useStatement";

// ---------------------------------------------------------------------------
// Adding, changing and copying a cost (the shared cost form, components/costs/CostForm.tsx), and the
// store's own categories. A change to a recurring cost's payments asks how far back it goes: from its
// next payment (the default: no month already reported changes) or every payment.
// ---------------------------------------------------------------------------

/** What the dialog edits: a new cost (blank or a copy of one), or one of the store's costs. */
export type Editing = { expense: ListedExpense | null; draft: CostDraft; copy?: boolean };

export function ExpenseDialog({
  editing,
  setEditing,
  base,
  currency,
  today,
  categories,
  onSaved,
  onCategoryAdded,
}: {
  editing: Editing | null;
  setEditing: (e: Editing | null) => void;
  base: string;
  currency: string;
  today: string;
  categories: readonly CustomCategory[];
  onSaved: () => Promise<void>;
  onCategoryAdded: () => Promise<void>;
}) {
  const { busy, run } = useAction();
  const [apply, setApply] = useState<"next" | "all">("next");
  const e = editing?.expense ?? null;
  const asks = !!editing && asksApplyFrom(e, today) && changesPayments(e!, editing.draft);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!editing) return;
    const ok = await run("save", e ? "save the expense" : "add the expense", async () => {
      await api(e ? `${base}/expenses/${e.id}?apply=${asks ? apply : "all"}` : `${base}/expenses`, { method: e ? "PUT" : "POST", body: inputOf(editing.draft, currency) });
      return e ? (asks && apply === "next" ? `Saved: the change applies from the next payment.` : "Expense saved.") : "Expense added.";
    });
    if (ok) {
      setEditing(null);
      setApply("next");
      await onSaved();
    }
  }

  async function createCategory(name: string, section: ExpenseSection): Promise<CustomCategory | null> {
    let made: CustomCategory | null = null;
    await run("category", "add the category", async () => {
      made = (await api<{ category: CustomCategory }>(`${base}/expense-categories`, { method: "POST", body: { name, section } })).category;
      await onCategoryAdded();
      return `${name} added.`;
    });
    return made;
  }

  return (
    <Dialog open={editing !== null} title={e ? "Edit expense" : editing?.copy ? "Duplicate expense" : "Add new expense"} onClose={() => setEditing(null)}>
      {editing && (
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" data-testid="pl-expense-form">
          <CostFields draft={editing.draft} currency={currency} set={(patch) => setEditing({ ...editing, draft: { ...editing.draft, ...patch } })} categories={categories} onCreateCategory={createCategory} />
          {asks && <ApplyChoice value={apply} onChange={setApply} next={e!.nextDue} />}
          <div className="flex gap-2 sm:col-span-2">
            <button className="btn-primary" disabled={busy === "save"} data-testid="pl-expense-save">
              {busy === "save" ? "Saving…" : e ? "Save" : "Add expense"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** The store's own categories: add, rename, move to another section, remove one no cost uses. */
export function CategoriesDialog({ open, onClose, base, categories, canManage, onChanged }: { open: boolean; onClose: () => void; base: string; categories: readonly CustomCategory[]; canManage: boolean; onChanged: () => Promise<void> }) {
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<{ id: string | null; name: string; section: ExpenseSection } | null>(null);
  const [removing, setRemoving] = useState<CustomCategory | null>(null);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!draft) return;
    const ok = await run("save", draft.id ? "save the category" : "add the category", async () => {
      await api(draft.id ? `${base}/expense-categories/${draft.id}` : `${base}/expense-categories`, { method: draft.id ? "PUT" : "POST", body: { name: draft.name, section: draft.section } });
      return draft.id ? "Category saved." : "Category added.";
    });
    if (ok) {
      setDraft(null);
      await onChanged();
    }
  }
  async function remove() {
    if (!removing) return;
    const ok = await run("remove", "remove the category", async () => {
      await api(`${base}/expense-categories/${removing.id}`, { method: "DELETE" });
      return "Category removed.";
    });
    setRemoving(null);
    if (ok) await onChanged();
  }

  return (
    <>
    <Dialog open={open} title="Expense categories" onClose={onClose}>
      <div className="space-y-4 text-sm" data-testid="pl-categories">
        <p className="text-muted">
          Your own categories sit beside the built-in ones (rent, staff, software, shipping…), each in the section of the profit and loss its costs go in. Up to {MAX_CUSTOM_CATEGORIES}.
        </p>
        {categories.length === 0 ? (
          <p className="text-muted">No categories of your own yet.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3 py-2" data-testid="pl-category-row">
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                <span className="text-xs text-muted">{EXPENSE_SECTION_LABEL[c.section]}</span>
                {canManage && (
                  <span className="flex gap-1">
                    <button type="button" className="grid size-8 place-items-center rounded-md text-muted hover:bg-bg hover:text-text" aria-label={`Edit ${c.name}`} onClick={() => setDraft({ id: c.id, name: c.name, section: c.section })}>
                      <Pencil aria-hidden className="h-4 w-4" />
                    </button>
                    <button type="button" className="grid size-8 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}>
                      <Trash2 aria-hidden className="h-4 w-4" />
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage &&
          (draft ? (
            <form onSubmit={save} className="grid gap-3 rounded-lg border border-border bg-bg/50 p-3 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="label">Name</span>
                <input className="input" required autoFocus maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="pl-category-name" />
              </label>
              <label className="space-y-1">
                <span className="label">Its costs go in</span>
                <select className="input" value={draft.section} onChange={(e) => setDraft({ ...draft, section: e.target.value as ExpenseSection })}>
                  {EXPENSE_SECTIONS.map((s) => (
                    <option key={s} value={s}>
                      {EXPENSE_SECTION_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              {draft.id && <p className="text-xs text-muted sm:col-span-2">Its costs move with it, past dates included.</p>}
              <div className="flex gap-2 sm:col-span-2">
                <button className="btn-primary" disabled={busy === "save"}>
                  {busy === "save" ? "Saving…" : draft.id ? "Save" : "Add category"}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="btn-secondary h-9 gap-1.5 px-3 text-sm" onClick={() => setDraft({ id: null, name: "", section: "fixed" })} data-testid="pl-category-add">
              <Plus aria-hidden className="h-4 w-4" />
              New category
            </button>
          ))}
      </div>
    </Dialog>
    <ConfirmDialog open={removing !== null} title="Remove this category?" confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={remove} onCancel={() => setRemoving(null)}>
      <p className="text-sm text-muted">{removing ? `${removing.name} is removed. A category that costs are in can't be: move them to another category first.` : ""}</p>
    </ConfirmDialog>
    </>
  );
}
