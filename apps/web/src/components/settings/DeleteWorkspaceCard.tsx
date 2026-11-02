"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { DeletionCodeField, TypeDelete, useDeletionCode } from "@/components/auth/security/DeletionCode";
import { ToneIcon, tone } from "@/components/auth/security/ui";
import { api, friendlyError } from "@/lib/api";
import type { CodeChallenge } from "@/lib/auth";

/** What deleting the workspace takes with it (GET /workspaces/:ws/deletion). */
interface Deletion {
  id: string;
  name: string;
  stores: Array<{ shopDomain: string; name: string | null }>;
  members: number;
  paidPlan: string | null;
}

/**
 * Settings → Workspace, for its owners: deleting the workspace (DELETE /workspaces/:ws; core
 * workspaceDeletion.ts says what goes), confirmed with DELETE and a code emailed to the owner's own
 * address for this workspace. The account stays; an only owner who wants it gone too deletes it in
 * Settings → Security, which deletes the workspace with it.
 */
export function DeleteWorkspaceCard() {
  const { workspace, me, reloadMe } = useApp();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Deletion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The workspace just deleted (the app has moved on to another one by now). */
  const [deleted, setDeleted] = useState<string | null>(null);
  const ws = workspace.id;
  const send = useCallback(() => api<{ ok: true; challenge: CodeChallenge }>(`/workspaces/${ws}/delete/code`, { method: "POST" }), [ws]);
  const deletion = useDeletionCode(send);
  const { reset } = deletion;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setPlan(null);
    setLoadError(null);
    api<{ workspace: Deletion }>(`/workspaces/${ws}/deletion`)
      .then((r) => live && setPlan(r.workspace))
      .catch((err: unknown) => live && setLoadError(friendlyError(err)));
    return () => {
      live = false;
    };
  }, [open, ws]);

  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
    reset();
  }, [reset]);
  // A switch to another workspace closes the dialog: it was about this one.
  useEffect(() => cancel(), [ws, cancel]);

  const canSend = typed === "DELETE" && !!plan && !plan.paidPlan;
  const ready = canSend && deletion.ready;
  const onlyOne = me.workspaces.length === 1;

  async function remove() {
    if (!ready || busy || !plan) return;
    setBusy(true);
    deletion.setError(null);
    try {
      await api(`/workspaces/${ws}`, { method: "DELETE", body: { confirm: "DELETE", code: deletion.code }, timeoutMs: 60_000 });
    } catch (err) {
      deletion.refused(err);
      setBusy(false);
      return;
    }
    setBusy(false);
    setDeleted(plan.name);
    cancel();
    // The app moves to another of the person's workspaces, or to onboarding when none is left.
    await reloadMe();
  }

  const done = deleted && (
    <div className="mb-4">
      <Alert kind="success" onDismiss={() => setDeleted(null)}>
        {deleted} was deleted, with its stores&apos; data.
      </Alert>
    </div>
  );
  // Only owners may delete it (workspace:delete); someone who just did may land in a workspace they don't own.
  if (workspace.role !== "owner") return done || null;
  return (
    <section className="tone-card rounded-xl border p-5 shadow-[var(--shadow)]" style={tone("danger")} aria-labelledby="delete-ws-h">
      {done}
      <div className="flex items-start gap-3.5">
        <ToneIcon icon={Trash2} t="danger" size="sm" />
        <div className="min-w-0">
          <h2 id="delete-ws-h" className="text-base font-semibold text-danger">
            Delete workspace
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Permanently deletes {workspace.name}: its stores&apos; data, everything set up here, and everyone&apos;s access to it. This can&apos;t be undone. Your account stays.
          </p>
          <button type="button" className="btn-danger mt-4 min-h-11" onClick={() => setOpen(true)}>
            Delete workspace
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title={`Delete ${workspace.name}?`}
        confirmLabel={busy ? "Deleting…" : "Delete workspace"}
        danger
        busy={busy}
        confirmDisabled={!ready}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-4">
          <p>This can&apos;t be undone. Deleting the workspace removes, for good:</p>
          {loadError && <Alert>{loadError}</Alert>}
          {!plan && !loadError && <p className="text-muted">Checking what it holds…</p>}
          {plan && (
            <>
              <ul className="list-disc space-y-1 pl-5" data-testid="delete-workspace-scope">
                <li>
                  {plan.stores.length
                    ? `The data of its ${plan.stores.length === 1 ? "store" : `${plan.stores.length} stores`} (${plan.stores.map((s) => s.name ?? s.shopDomain).join(", ")}): orders, products, customers, figures and reports.`
                    : "Its settings and records (it has no store)."}
                </li>
                <li>Everything set up here: costs, business events, alerts, automations, email, SMS and WhatsApp messaging, staff records.</li>
                <li>Its connections: Meta, Google, WhatsApp, email accounts, Zapier and API keys stop working.</li>
                <li>{plan.members > 1 ? `Access for ${plan.members} people, you included.` : "Your access to it."}</li>
              </ul>
              {plan.stores.length > 0 && <p>bizinsights stays installed in Shopify until you remove it there (Shopify admin → Settings → Apps).</p>}
              {onlyOne && (
                <p>
                  Deleting your account too? Delete it in <Link href="/settings/security" className="underline">Settings → Security</Link> instead: that deletes this workspace with it.
                </p>
              )}
              {plan.paidPlan && (
                <Alert>
                  This workspace is on a paid plan billed through Shopify. <Link href="/settings/billing" className="underline">Switch it to Free</Link> first, so the charge ends.
                </Alert>
              )}
            </>
          )}
          <TypeDelete id="type-delete-workspace" value={typed} onChange={setTyped} />
          <DeletionCodeField state={deletion} busy={busy} canSend={canSend} hint={typed !== "DELETE" ? "Type DELETE above first." : null} purpose="delete this workspace" />
        </div>
      </ConfirmDialog>
    </section>
  );
}
