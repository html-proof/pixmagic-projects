"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { accountDeletionPreview, deleteAccount, sendDeletionCode, soleOwnedFromError, type SoleWorkspace } from "@/lib/auth";
import { DeletionCodeField, TypeDelete, useDeletionCode } from "./DeletionCode";
import { ToneIcon, tone } from "./ui";

/** "2 stores: Acme, Acme EU" / "no store", for the list of workspaces that go with the account. */
function storesOf(w: SoleWorkspace) {
  if (!w.stores.length) return "no store";
  return `${w.stores.length} ${w.stores.length === 1 ? "store" : "stores"}: ${w.stores.join(", ")}`;
}

/**
 * Deleting the account: typed DELETE, and a 6-digit code emailed to the account's address
 * (apps/api/src/routes/account.ts), whatever the session signed in with. No password field: beside
 * one, the browser's password manager took the DELETE box for the username and filled the account's
 * address into it. The address isn't shown in the dialog either.
 *
 * The workspaces the account is the only owner of go with it (core workspaceDeletion.ts): the
 * dialog lists them, and asks for them to be ticked off, before any code is sent. One on a paid plan
 * has to be switched to Free first.
 */
export function DeleteCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  /** The workspaces that go with the account; null while they load. */
  const [owned, setOwned] = useState<SoleWorkspace[] | null>(null);
  /** Their deletion ticked off. */
  const [agreed, setAgreed] = useState(false);
  const deletion = useDeletionCode(sendDeletionCode);
  const { reset, setError } = deletion;

  useEffect(() => {
    if (!open) return;
    let live = true;
    setOwned(null);
    accountDeletionPreview()
      .then((r) => live && setOwned(r.workspaces))
      // Unknown: the deletion itself refuses (sole_owner, with the list) if any would go unannounced.
      .catch(() => live && setOwned([]));
    return () => {
      live = false;
    };
  }, [open]);

  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
    setAgreed(false);
    reset();
  }, [reset]);

  const paid = owned?.filter((w) => w.paidPlan) ?? [];
  const withWorkspaces = !!owned?.length;
  const canSend = typed === "DELETE" && owned !== null && !paid.length && (!withWorkspaces || agreed);
  const hint = typed !== "DELETE" ? "Type DELETE above first." : withWorkspaces && !agreed && !paid.length ? "Tick the box above first." : null;
  const ready = canSend && deletion.ready;

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(deletion.code, (owned ?? []).map((w) => w.id));
      router.replace("/login?deleted=1");
    } catch (err) {
      // The workspaces that would go changed since the dialog listed them: listed again, to be ticked again.
      const now = soleOwnedFromError(err);
      if (now) {
        setOwned(now);
        setAgreed(false);
      }
      deletion.refused(err);
      setBusy(false);
    }
  }

  return (
    <section className="tone-card rounded-xl border p-5 shadow-[var(--shadow)]" style={tone("danger")} aria-labelledby="delete-h">
      <div className="flex items-start gap-3.5">
        <ToneIcon icon={Trash2} t="danger" size="sm" />
        <div className="min-w-0">
          <h2 id="delete-h" className="text-base font-semibold text-danger">
            Delete account
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            Permanently deletes your sign-in and your personal account. This can&apos;t be undone. Workspaces with another owner keep running without you. A workspace you&apos;re the only owner of is deleted with your account, with its stores&apos; data.
          </p>
          <button type="button" className="btn-danger mt-4 min-h-11" onClick={() => setOpen(true)}>
            Delete my account
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        title="Delete your account?"
        confirmLabel={busy ? "Deleting…" : "Delete account"}
        danger
        busy={busy}
        confirmDisabled={!ready}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-4">
          <p>This can&apos;t be undone.</p>
          {withWorkspaces && (
            <div className="space-y-2 rounded-xl border border-border bg-bg/40 p-3.5" data-testid="delete-workspaces">
              <p>
                You&apos;re the only owner of {owned!.length > 1 ? "these workspaces" : "this workspace"}. Deleting your account deletes {owned!.length > 1 ? "them" : "it"} too: the stores&apos; data, everything set up there, and everyone&apos;s access to {owned!.length > 1 ? "them" : "it"}.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {owned!.map((w) => (
                  <li key={w.id}>
                    <span className="font-medium text-text">{w.name}</span> ({storesOf(w)}
                    {w.members > 1 ? `; ${w.members - 1} other ${w.members === 2 ? "person loses" : "people lose"} access` : ""})
                  </li>
                ))}
              </ul>
              {paid.length ? (
                <Alert>
                  {paid.map((w) => w.name).join(", ")} {paid.length > 1 ? "are on paid plans" : "is on a paid plan"} billed through Shopify. Switch {paid.length > 1 ? "them" : "it"} to Free in Settings → Billing first, so the charge ends.
                </Alert>
              ) : (
                <label className="flex items-start gap-2.5">
                  <input type="checkbox" className="mt-1 size-4 shrink-0" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>Also delete {owned!.length > 1 ? "these workspaces" : owned![0]!.name} and all of {owned!.length > 1 ? "their" : "its"} data</span>
                </label>
              )}
              <p className="text-xs">To keep a workspace, make someone else its owner first, in Team &amp; Access.</p>
            </div>
          )}
          <TypeDelete id="type-delete" value={typed} onChange={setTyped} />
          <DeletionCodeField state={deletion} busy={busy} canSend={canSend} hint={hint} purpose={withWorkspaces ? "delete your account and the workspaces above" : "delete your account"} />
        </div>
      </ConfirmDialog>
    </section>
  );
}
