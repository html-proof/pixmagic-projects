"use client";
import { useEffect, useState, type FormEvent } from "react";
import { AccountSecurity } from "@/components/auth/AccountSecurity";
import { LoadError } from "@/components/LoadError";
import { usePortal, type EmployeeDashboard } from "@/components/staff/PortalContext";
import { Field } from "@/components/staff/ui";
import { Skeleton, useToast } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------------------------
// The employee's account: their details (HR keeps all but the phone number up to date), and
// account security (password, email, signing out here or everywhere, deletion).
// ---------------------------------------------------------------------------------------------

const PHONE_RE = /^[+0-9 ().-]*$/;

export default function PortalAccount() {
  const { ws, employment } = usePortal();
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

      <div className="pt-2">
        <AccountSecurity heading="h2" intro="Your email, password, the devices you're signed in on, and your recent sign-ins." />
      </div>
    </>
  );
}
