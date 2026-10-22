"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { accountPasswordProblem, ACCOUNT_PASSWORD_MIN } from "@app/shared/auth";
import { Dialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { PasswordField } from "@/components/auth/PasswordField";
import { addPassword, changePassword, type AccountInfo } from "@/lib/auth";
import { day, failure, Pill, SummaryCard, type Msg } from "./ui";

/** The password: when it was last set, and changing it (or adding one to a Google-only account). */
export function PasswordCard({ account: a, provider, onChanged }: { account: AccountInfo; provider: string | null; onChanged: (notice: string) => void }) {
  const [open, setOpen] = useState(false);
  const adding = !a.hasPassword;
  return (
    <SummaryCard
      id="password-h"
      t="violet"
      icon={LockKeyhole}
      title="Password"
      action={
        <button type="button" className="btn-secondary min-h-10 shrink-0 px-4 whitespace-nowrap" onClick={() => setOpen(true)}>
          {adding ? "Add" : "Change"}
        </button>
      }
    >
      {a.hasPassword ? (
        <>
          <p className="font-semibold tracking-[0.3em] text-text select-none" aria-label="Password set">
            ••••••••••••
          </p>
          <p className="text-muted">{a.passwordChangedAt ? `Last changed on ${day(a.passwordChangedAt)}` : "Set"}</p>
        </>
      ) : (
        <>
          <p>
            <Pill t="info">Not set</Pill>
          </p>
          <p className="text-muted">You sign in with {provider ?? "Google"} only.</p>
        </>
      )}
      <PasswordDialog
        open={open}
        account={a}
        provider={provider}
        onClose={() => setOpen(false)}
        onChanged={(notice) => {
          setOpen(false);
          onChanged(notice);
        }}
      />
    </SummaryCard>
  );
}

function PasswordDialog({ open, account: a, provider, onClose, onChanged }: { open: boolean; account: AccountInfo; provider: string | null; onClose: () => void; onChanged: (notice: string) => void }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setMsg(null);
  }
  function close() {
    reset();
    onClose();
  }

  function check() {
    const weak = accountPasswordProblem(next);
    if (weak) return weak;
    if (next !== confirm) return a.hasPassword ? "The two new passwords don't match." : "The two passwords don't match.";
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = check();
    if (problem) return setMsg({ kind: "error", text: problem });
    setBusy(true);
    setMsg(null);
    try {
      if (a.canChangePassword) {
        const r = await changePassword({ currentPassword: current, password: next, confirmPassword: confirm });
        // Two-step verification is on: the new password signs in with a code, this browser included.
        if (!r.signedIn) return router.replace("/login?reset=1");
        reset();
        onChanged("Password changed. You've been signed out on your other devices.");
      } else {
        await addPassword({ password: next, confirmPassword: confirm });
        reset();
        onChanged(`Password added. You can now sign in with ${a.user.email} and this password, or with Google.`);
      }
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const actions = (label: string, busyLabel: string, ready: boolean) => (
    <div className="flex flex-wrap justify-end gap-2 pt-1">
      <button type="button" className="btn-secondary" onClick={close}>
        Cancel
      </button>
      <button className="btn-primary" disabled={busy || !ready}>
        {busy ? busyLabel : label}
      </button>
    </div>
  );

  return (
    <Dialog open={open} title={a.hasPassword ? "Change password" : "Add a password"} onClose={close}>
      <div className="space-y-3 text-sm">
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {a.canChangePassword ? (
          <form onSubmit={submit} className="grid gap-3">
            <PasswordField id="current-password" label="Current password" autoComplete="current-password" value={current} onChange={setCurrent} />
            <PasswordField id="new-password" label="New password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={next} onChange={setNext} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters. Changing it signs you out everywhere else.`} />
            <PasswordField id="confirm-new-password" label="Confirm new password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
            {actions("Change password", "Changing…", !!current && !!next && !!confirm)}
          </form>
        ) : a.hasPassword ? (
          <p className="text-muted">
            You signed in with {provider ?? "another provider"}. To change your password, sign in with {a.user.email} and your password, or use{" "}
            <Link prefetch={false} href="/forgot-password" className="underline">
              Forgot Password?
            </Link>{" "}
            on the sign-in page.
          </p>
        ) : !a.canAddPassword ? (
          <p className="text-muted">You have no password yet. To add one, sign in with Google using {a.user.email}, your account&apos;s address, then come back here.</p>
        ) : (
          <form onSubmit={submit} className="grid gap-3">
            <p className="text-muted">
              You sign in with {provider ?? "another provider"} only. Add a password to also sign in with {a.user.email}. For your safety this needs a sign-in in the last 15 minutes.
            </p>
            <PasswordField id="add-password" label="Password" autoComplete="new-password" minLength={ACCOUNT_PASSWORD_MIN} value={next} onChange={setNext} hint={`At least ${ACCOUNT_PASSWORD_MIN} characters.`} />
            <PasswordField id="confirm-add-password" label="Confirm password" autoComplete="new-password" value={confirm} onChange={setConfirm} />
            {actions("Add a password", "Adding…", !!next && !!confirm)}
          </form>
        )}
      </div>
    </Dialog>
  );
}
