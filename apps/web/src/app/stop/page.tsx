"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, AuthShell } from "@/components/ui";
import { actionError, api } from "@/lib/api";

/** The API's own words for a code it doesn't know (a public call's errors are otherwise worded here). */
const MESSAGES = { not_found: "This link isn't valid any more. Reply STOP to the text, or contact the store." };

interface OptOut {
  business: string;
  /** Masked: "+61 •••••• 678". */
  number: string;
  stopped: "none" | "marketing" | "all";
}

/**
 * Where the opt-out link in a marketing text lands (/stop?c=<code>). The code names the business
 * and the number (masked); nothing changes until the person confirms, so a link preview can't opt
 * anyone out. Replying STOP to the text works too, where the sender takes replies.
 */
export default function StopPage() {
  return (
    <Suspense fallback={<AuthShell title="Stop texts">Loading…</AuthShell>}>
      <Stop />
    </Suspense>
  );
}

function Stop() {
  const code = useSearchParams().get("c") ?? "";
  const [info, setInfo] = useState<OptOut | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"marketing" | "all" | null>(null);

  useEffect(() => {
    if (!code) {
      setErr("This link is incomplete. Reply STOP to the text, or contact the store.");
      return;
    }
    api<OptOut>(`/sms/u/${encodeURIComponent(code)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(setInfo)
      .catch((e) => setErr(actionError(e, "open this link", MESSAGES)));
  }, [code]);

  const stop = async (scope: "marketing" | "all") => {
    setBusy(scope);
    setErr(null);
    try {
      const r = await api<Partial<OptOut>>(`/sms/u/${encodeURIComponent(code)}`, { method: "POST", body: { scope }, credentials: "omit", referrerPolicy: "no-referrer" });
      setInfo((prev) => (prev ? { ...prev, ...r, stopped: r.stopped ?? scope } : prev));
    } catch (e) {
      setErr(actionError(e, "stop the texts", MESSAGES));
    } finally {
      setBusy(null);
    }
  };

  if (err && !info) {
    return (
      <AuthShell title="Stop texts">
        <Alert>{err}</Alert>
      </AuthShell>
    );
  }
  if (!info) return <AuthShell title="Stop texts">Loading…</AuthShell>;
  if (info.stopped === "all") {
    return (
      <AuthShell title="You won't get any more texts" subtitle={`${info.business} won't text ${info.number} any more, including order updates.`}>
        <p className="text-sm text-muted">This took effect straight away. To get texts again, sign up for them with {info.business}.</p>
      </AuthShell>
    );
  }
  if (info.stopped === "marketing") {
    return (
      <AuthShell title="Marketing texts stopped" subtitle={`${info.business} won't send marketing texts to ${info.number} any more.`}>
        <p className="text-sm text-muted">Texts about orders you place, such as shipping updates, may still reach you.</p>
        {err && <Alert>{err}</Alert>}
        <button type="button" className="btn-secondary w-full" disabled={!!busy} onClick={() => void stop("all")}>
          {busy === "all" ? "Stopping…" : "Stop all texts, including order updates"}
        </button>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Stop texts" subtitle={`Stop marketing texts from ${info.business} to ${info.number}?`}>
      {err && <Alert>{err}</Alert>}
      <button type="button" className="btn-primary w-full" disabled={!!busy} onClick={() => void stop("marketing")}>
        {busy === "marketing" ? "Stopping…" : "Stop marketing texts"}
      </button>
      <button type="button" className="btn-secondary w-full" disabled={!!busy} onClick={() => void stop("all")}>
        {busy === "all" ? "Stopping…" : "Stop all texts, including order updates"}
      </button>
      <p className="text-xs text-muted">Nothing changes until you choose. It takes effect straight away.</p>
    </AuthShell>
  );
}
