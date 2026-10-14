"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { LoadError } from "@/components/LoadError";
import { portalSignOut, usePortal, type EmployeeDashboard } from "@/components/staff/PortalContext";
import { Field } from "@/components/staff/ui";
import { Alert } from "@/components/ui";
import { ConfirmDialog, Skeleton, useToast } from "@/components/whatsapp/common";
import { actionError, api, useApi } from "@/lib/api";
import { firebaseAuth } from "@/lib/firebase";

// ---------------------------------------------------------------------------------------------
// The employee's account: their details (HR keeps all but the phone number up to date), their
// password, and signing out here or everywhere.
// ---------------------------------------------------------------------------------------------

const PHONE_RE = /^[+0-9 ().-]*$/;

export default function PortalAccount() {
  const { ws, me, employment } = usePortal();
  const router = useRouter();
  const toast = useToast();
  // The portal has no separate profile endpoint: the dashboard answer carries the employee's details.
  const q = useApi<EmployeeDashboard>(`/employee/${ws}/dashboard`);
  const emp = q.data?.employee;

  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  useEffect(() => {
    if (emp) setPhone(emp.phone ?? "");
  }, [emp]);

  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [allBusy, setAllBusy] = useState(false);
  const cancelAll = useCallback(() => setConfirmAll(false), []);

  const inactive = employment.status === "inactive";
  const dirty = !!emp && phone.trim() !== (emp.phone ?? "");

  async function savePhone(e: FormEvent) {
    e.preventDefault();
    const value = phone.trim();
    if (!PHONE_RE.test(value)) {
      setPhoneError("Use digits, spaces and + ( ) - only.");
      return;
    }
    setPhoneError(null);
    setSaving(true);
    try {
      await api(`/employee/${ws}/profile`, { method: "PATCH", body: { phone: value || null } });
      toast("success", "Phone number saved.");
      await q.reload();
    } catch (err) {
      setPhoneError(actionError(err, "save your phone number"));
    } finally {
      setSaving(false);
    }
  }

  async function sendReset() {
    setResetBusy(true);
    // Same message whatever happens (like /reset), so this can't be used to probe accounts.
    await sendPasswordResetEmail(firebaseAuth(), me.user.email, { url: `${window.location.origin}/login` }).catch(() => {});
    setResetSent(true);
    setResetBusy(false);
  }

  async function signOutEverywhere() {
    setAllBusy(true);
    try {
      await api("/auth/sessions/revoke", { method: "POST" });
    } catch (err) {
      toast("error", actionError(err, "sign you out everywhere"));
      setAllBusy(false);
      setConfirmAll(false);
      return;
    }
    await firebaseAuth()
      .signOut()
      .catch(() => {});
    router.replace("/login?signedOut=1");
  }

  return (
    <>
      <section className="card animate-rise">
        <h1 className="text-xl font-semibold">Account</h1>
        <p className="mt-1 text-sm text-muted">Your details at {employment.organization}, your password and where you&apos;re signed in.</p>
      </section>

      <section className="card" aria-labelledby="profile-h">
        <h2 id="profile-h" className="font-semibold">
          Your details
        </h2>
        {q.error && !q.data ? (
          <div className="mt-3">
            <LoadError what="your details" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
          </div>
        ) : !emp ? (
          <div className="mt-3">
            <Skeleton lines={4} />
          </div>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              {(
                [
                  ["Name", emp.fullName],
                  ["Email", emp.email],
                  ["Position", emp.jobTitle || "—"],
                  ["Employee ID", emp.employeeNumber],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="min-w-0 rounded-lg border border-border bg-bg/50 px-3 py-2">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="truncate font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted">Something wrong here? Ask your manager to update it.</p>
            <form onSubmit={savePhone} className="mt-4 flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1 sm:max-w-xs">
                <Field label="Phone number" htmlFor="phone" error={phoneError} hint={inactive ? "Your account is deactivated, so this can't be changed." : "So your manager can reach you about shifts."}>
                  <input
                    id="phone"
                    className="input min-h-11"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    maxLength={40}
                    value={phone}
                    disabled={inactive}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </Field>
              </div>
              {!inactive && (
                <button type="submit" className="btn-primary min-h-11" disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
            </form>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="password-h">
        <h2 id="password-h" className="font-semibold">
          Password
        </h2>
        <p className="mt-1 text-sm text-muted">We&apos;ll email you a link to choose a new password.</p>
        {resetSent ? (
          <div className="mt-3">
            <Alert kind="success">If you sign in with a password, a link to change it is on its way to {me.user.email}. Check your inbox (and spam folder).</Alert>
          </div>
        ) : (
          <button type="button" className="btn-secondary mt-3 min-h-11" onClick={() => void sendReset()} disabled={resetBusy}>
            {resetBusy ? "Sending…" : "Change password"}
          </button>
        )}
        <p className="mt-3 text-xs text-muted">Two-step verification isn&apos;t available yet. Use a strong password you don&apos;t use anywhere else.</p>
      </section>

      <section className="card" aria-labelledby="signout-h">
        <h2 id="signout-h" className="font-semibold">
          Signing out
        </h2>
        <p className="mt-1 text-sm text-muted">Signed in on a shared or lost device? Sign out of all devices to end every session, including this one.</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button type="button" className="btn-secondary min-h-11" onClick={() => void portalSignOut(router)}>
            Sign out
          </button>
          <button type="button" className="btn-danger min-h-11" onClick={() => setConfirmAll(true)}>
            Sign out of all devices
          </button>
        </div>
      </section>

      <ConfirmDialog open={confirmAll} title="Sign out of all devices?" confirmLabel="Sign out everywhere" danger busy={allBusy} onCancel={cancelAll} onConfirm={() => void signOutEverywhere()}>
        <p>Every browser and phone signed in to your account will be signed out, including this one. You&apos;ll need your password to sign in again.</p>
      </ConfirmDialog>
    </>
  );
}
