"use client";
import { useState } from "react";
import { FUNNEL_ACTIONS } from "@app/shared/funnel";
import { FUNNEL_STEPS } from "@app/shared/journey";
import { useApp } from "@/components/AppContext";
import type { FunnelPageModule } from "@/components/dashboard/types";
import { Alert } from "@/components/ui";
import { api, friendlyError } from "@/lib/api";
import { liveDataChanged } from "@/hooks/useApi";
import { FunnelSection } from "./FunnelUi";
import { STAGES } from "./stageGuide";

type Done = Record<string, { doneAt: string; doneByName: string | null } | null>;

/**
 * "Recommended actions by funnel stage": things worth checking at each stage, which the team ticks
 * off per store (PUT …/funnel/actions/:id, kept in funnel_action_checks). A shared, view-only
 * dashboard sees the list without the checkboxes working.
 */
export function ActionChecklist({ f }: { f: FunnelPageModule }) {
  const { workspace, store, me } = useApp();
  // Ticks made here show at once; the next answer from the API confirms them.
  const [mine, setMine] = useState<Done>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !!me.shared;
  const server = new Map(f.actions.map((a) => [a.id, a]));
  const state = (id: string) => (id in mine ? mine[id] : server.has(id) ? { doneAt: server.get(id)!.doneAt, doneByName: server.get(id)!.doneByName } : null);
  const doneCount = FUNNEL_ACTIONS.filter((a) => state(a.id)).length;

  const toggle = async (id: string, done: boolean) => {
    if (!store) return;
    const was = state(id);
    const who = me.user.displayName ?? me.user.email;
    // Ticked at once; put back if the save fails.
    setMine((m) => ({ ...m, [id]: done ? { doneAt: new Date().toISOString(), doneByName: who } : null }));
    setBusy(id);
    setError(null);
    try {
      const r = await api<{ doneAt: string | null }>(`/workspaces/${workspace.id}/stores/${store.id}/funnel/actions/${id}`, { method: "PUT", body: { done } });
      setMine((m) => ({ ...m, [id]: done && r.doneAt ? { doneAt: r.doneAt, doneByName: who } : null }));
      liveDataChanged();
    } catch (e) {
      setMine((m) => ({ ...m, [id]: was }));
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <FunnelSection
      id="actions"
      title="Recommended actions by funnel stage"
      sub={readOnly ? "Practical checks for each stage of the funnel." : "Practical checks for each stage. Tick them off as you go: the list is kept for this store and shared with your team, so you can come back and see whether the funnel improved."}
      aside={
        <span className="text-xs text-muted" data-testid="funnel-actions-count">
          {doneCount} of {FUNNEL_ACTIONS.length} done
        </span>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {FUNNEL_STEPS.map((step, k) => (
          <fieldset key={step} className="min-w-0 rounded-xl border border-border p-3">
            <legend className="px-1 text-sm font-semibold">
              {k + 1}. {STAGES[step].name}
            </legend>
            <ul className="space-y-2">
              {FUNNEL_ACTIONS.filter((a) => a.step === step).map((a) => {
                const s = state(a.id);
                return (
                  <li key={a.id}>
                    <label className={`flex gap-2.5 rounded-lg p-1.5 text-sm ${readOnly ? "" : "cursor-pointer hover:bg-bg"}`}>
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                        checked={!!s}
                        disabled={readOnly || busy === a.id}
                        onChange={(e) => void toggle(a.id, e.target.checked)}
                        data-testid={`funnel-action-${a.id}`}
                      />
                      <span className="min-w-0">
                        <span className={`block font-medium ${s ? "text-muted line-through" : ""}`}>{a.label}</span>
                        <span className="block text-xs text-muted">{a.detail}</span>
                        {s && (
                          <span className="mt-0.5 block text-[11px] text-good">
                            Done{s.doneByName ? ` by ${s.doneByName}` : ""} on {new Date(s.doneAt).toLocaleDateString(undefined, { dateStyle: "medium" })}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ))}
      </div>
    </FunnelSection>
  );
}
