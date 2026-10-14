"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, AuthShell } from "@/components/ui";
import { actionError, api } from "@/lib/api";

/**
 * Where an email's "Unsubscribe" link lands. The link's token names the business and the recipient
 * (masked); nothing changes until the person confirms. Mail providers' one-click unsubscribe posts
 * to the API directly (RFC 8058) and never sees this page.
 */
export default function UnsubscribePage() {
  return (
    <Suspense fallback={<AuthShell title="Unsubscribe">Loading…</AuthShell>}>
      <Unsubscribe />
    </Suspense>
  );
}

function Unsubscribe() {
  const token = useSearchParams().get("t") ?? "";
  const [info, setInfo] = useState<{ email: string; business: string; unsubscribed: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) {
      setErr("This unsubscribe link is incomplete.");
      return;
    }
    api<{ email: string; business: string; unsubscribed: boolean }>(`/email/unsubscribe/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setErr(actionError(e, "open this link")));
  }, [token]);

  if (err) {
    return (
      <AuthShell title="Unsubscribe">
        <Alert>{err}</Alert>
      </AuthShell>
    );
  }
  if (!info) return <AuthShell title="Unsubscribe">Loading…</AuthShell>;
  if (done || info.unsubscribed) {
    return (
      <AuthShell title="You're unsubscribed" subtitle={`${info.business} won't send marketing email to ${info.email} any more.`}>
        <p className="text-sm text-muted">Emails about orders or bookings you make may still reach you.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Unsubscribe" subtitle={`Stop marketing email from ${info.business} to ${info.email}?`}>
      <button
        className="btn-primary w-full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/email/unsubscribe/${encodeURIComponent(token)}`, { method: "POST" });
            setDone(true);
          } catch (e) {
            setErr(actionError(e, "unsubscribe"));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Unsubscribing…" : "Unsubscribe"}
      </button>
    </AuthShell>
  );
}
