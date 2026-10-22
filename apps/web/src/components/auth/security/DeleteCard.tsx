"use client";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { deleteAccount, type AccountInfo } from "@/lib/auth";
import { ConfirmItsYou } from "./MethodsCard";
import { failure, ToneIcon, tone, type Msg } from "./ui";

/** Deleting the account: typed DELETE, and the person again (ConfirmItsYou). */
export function DeleteCard({ account: a }: { account: AccountInfo }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const cancel = useCallback(() => {
    setOpen(false);
    setTyped("");
    setPassword("");
  }, []);
  const needsPassword = a.confirmWith === "password";
  const cantConfirm = a.confirmWith === "own_address_sign_in";

  async function remove() {
    if (typed !== "DELETE" || cantConfirm || (needsPassword && !password)) return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteAccount(needsPassword ? password : undefined);
      router.replace("/login?deleted=1");
    } catch (err) {
      setMsg(failure(err));
      setOpen(false);
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
            Permanently deletes your sign-in and your personal account. This can&apos;t be undone. Workspaces you own with no other owner must be deleted or handed over first; workspaces others own keep running without you.
          </p>
          {msg && (
            <div className="mt-3">
              <Alert kind={msg.kind}>{msg.text}</Alert>
            </div>
          )}
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
        confirmDisabled={typed !== "DELETE" || cantConfirm || (needsPassword && !password)}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-3">
          <p>This can&apos;t be undone.</p>
          <div>
            <label className="label" htmlFor="type-delete">
              Type DELETE to confirm
            </label>
            <input id="type-delete" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <ConfirmItsYou account={a} id="delete-password" password={password} onPassword={setPassword} />
        </div>
      </ConfirmDialog>
    </section>
  );
}
