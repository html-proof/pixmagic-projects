"use client";
import { useId, useState, type FormEvent } from "react";
import { useToast } from "@/components/AppUi";
import { api } from "@/lib/api";
import type { WaConnection } from "./types";
import { waError } from "./WaUi";

// ---------------------------------------------------------------------------
// bizinsights' own team only (the API offers it to the workspaces in WHATSAPP_TOKEN_CONNECT_WORKSPACES):
// connect with a token of bizinsights' Meta app made in Meta's dashboard, instead of Meta's window,
// e.g. the app's test number to record Meta's App Review. The server checks the token with Meta
// exactly as it checks Embedded Signup's (core whatsapp/cloud.ts); the field is cleared once sent and
// the token is never shown again.
// ---------------------------------------------------------------------------

export function AppTokenConnect({ base, onConnected }: { base: string; onConnected: (c: WaConnection) => void }) {
  const id = useId();
  const toast = useToast();
  const [form, setForm] = useState({ wabaId: "", phoneNumberId: "", accessToken: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const ready = /^\d{5,25}$/.test(form.wabaId.trim()) && /^\d{5,25}$/.test(form.phoneNumberId.trim()) && form.accessToken.trim().length >= 20;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ connection: WaConnection }>(`${base}/connection/cloud-token`, { method: "POST", body: { wabaId: form.wabaId.trim(), phoneNumberId: form.phoneNumberId.trim(), accessToken: form.accessToken.trim() } });
      setForm({ wabaId: "", phoneNumberId: "", accessToken: "" });
      toast("success", `WhatsApp Business is connected${r.connection.phone ? `: ${r.connection.phone}` : ""}.`);
      onConnected(r.connection);
    } catch (err) {
      setForm((f) => ({ ...f, accessToken: "" }));
      setError(waError(err, "connect with the token"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-lg border border-border bg-bg p-3" data-testid="wa-token-connect">
      <summary className="cursor-pointer text-sm font-semibold">bizinsights team: connect with the app&apos;s own token</summary>
      <form className="mt-3 space-y-3" onSubmit={(e) => void submit(e)}>
        <p className="max-w-2xl text-xs text-muted">
          For recording Meta&apos;s App Review before Meta approves bizinsights as a Tech Provider. In the Insights app&apos;s dashboard (WhatsApp → API Setup) copy the WhatsApp Business account ID and the phone number ID, and make a token with
          whatsapp_business_management and whatsapp_business_messaging (a system user&apos;s in Business settings, or API Setup&apos;s temporary one). bizinsights checks the token with Meta and keeps it encrypted.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor={`${id}-waba`}>
              WhatsApp Business account ID
            </label>
            <input id={`${id}-waba`} className="input" inputMode="numeric" autoComplete="off" value={form.wabaId} onChange={(e) => set("wabaId", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-phone`}>
              Phone number ID
            </label>
            <input id={`${id}-phone`} className="input" inputMode="numeric" autoComplete="off" value={form.phoneNumberId} onChange={(e) => set("phoneNumberId", e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-token`}>
            Access token
          </label>
          <input id={`${id}-token`} className="input" type="password" autoComplete="off" spellCheck={false} value={form.accessToken} onChange={(e) => set("accessToken", e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" disabled={!ready || busy}>
          {busy ? "Checking with Meta…" : "Connect with this token"}
        </button>
        {error && (
          <p role="alert" className="max-w-xl text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
