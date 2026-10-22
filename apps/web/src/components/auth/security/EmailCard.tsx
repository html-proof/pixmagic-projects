"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { isEmailAddress } from "@app/shared/auth";
import { Dialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { CodeStep } from "@/components/auth/CodeStep";
import { PasswordField } from "@/components/auth/PasswordField";
import { confirmEmailChange, startEmailChange, type AccountInfo } from "@/lib/auth";
import { failure, Pill, SummaryCard, type Msg } from "./ui";

/** The account's address, whether it is verified, and changing it (a code to the new address confirms it). */
export function EmailCard({ account: a, provider, onChanged }: { account: AccountInfo; provider: string | null; onChanged: (notice: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <SummaryCard
      id="email-h"
      t="info"
      icon={Mail}
      title="Email address"
      action={
        <button type="button" className="btn-secondary min-h-10 shrink-0 px-4 whitespace-nowrap" onClick={() => setOpen(true)}>
          Change
        </button>
      }
    >
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-medium break-all">{a.user.email}</span>
        {a.user.emailVerified ? <Pill t="good">Verified</Pill> : <Pill t="warn">Not verified</Pill>}
      </p>
      {a.user.emailVerified ? (
        <p className="text-muted">Used for sign-in and important notifications.</p>
      ) : (
        <p className="text-muted">
          Verify it so you can always get back in.{" "}
          <Link href="/verify-email" className="font-medium text-text underline">
            Verify it now
          </Link>
        </p>
      )}
      <EmailDialog
        open={open}
        account={a}
        provider={provider}
        onClose={() => setOpen(false)}
        onChanged={() => {
          setOpen(false);
          onChanged("Your email address has been changed.");
        }}
      />
    </SummaryCard>
  );
}

function EmailDialog({ open, account: a, provider, onClose, onChanged }: { open: boolean; account: AccountInfo; provider: string | null; onClose: () => void; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  function close() {
    setEmail("");
    setPassword("");
    setPending(null);
    setMsg(null);
    onClose();
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    if (!isEmailAddress(email)) return setMsg({ kind: "error", text: "Enter a valid email address." });
    setBusy(true);
    setMsg(null);
    try {
      const r = await startEmailChange(email.trim(), password);
      setPending(r.pendingEmail);
      setPassword("");
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title="Change email address" onClose={close}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Now <strong className="font-medium text-text">{a.user.email}</strong>. You sign in with it, and it gets the emails about your account.
        </p>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {!a.canChangeEmail && !provider ? (
          <p className="text-muted">Verify this address first, then you can change it here. If it isn&apos;t yours, ask whoever invited you to invite the right one.</p>
        ) : !a.canChangeEmail ? (
          <p className="text-muted">You signed in with {provider}, which manages this address. Change it there, or sign in with your email and password to change it here.</p>
        ) : pending ? (
          <div>
            <CodeStep
              email={pending}
              intro={
                <>
                  We emailed a 6-digit code to <strong>{pending}</strong>. Your address changes once you enter it.
                </>
              }
              submitLabel="Confirm new address"
              onSubmit={async (code) => {
                await confirmEmailChange(code);
                setPending(null);
                setEmail("");
                onChanged();
              }}
            />
            <button type="button" className="mt-2 text-sm text-muted underline" onClick={() => setPending(null)}>
              Use a different address
            </button>
          </div>
        ) : (
          <form onSubmit={start} className="grid gap-3">
            <div>
              <label className="label" htmlFor="new-email">
                New email address
              </label>
              <input id="new-email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <PasswordField id="email-password" label="Current password" autoComplete="current-password" value={password} onChange={setPassword} />
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button className="btn-primary" disabled={busy || !email || !password}>
                {busy ? "Sending code…" : "Change email"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
