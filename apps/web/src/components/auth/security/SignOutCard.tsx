"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LogOut } from "lucide-react";
import { Alert } from "@/components/ui";
import { authErrorMessage, leaveTo, signOut } from "@/lib/auth";
import { CardHeader, tone } from "./ui";

/** Sign out here, or everywhere (the page's confirm dialog, which the device list opens too). */
export function SignOutCard({ onSignOutAll }: { onSignOutAll: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function here() {
    setBusy(true);
    setError(null);
    try {
      leaveTo(await signOut(), router);
    } catch (err) {
      setError(authErrorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="sessions-h">
      <CardHeader id="sessions-h" t="danger" icon={LogOut} title="Sign out" sub="Sign out from the current device or all devices to end your session." />
      {error && (
        <div className="mt-4">
          <Alert kind="error">{error}</Alert>
        </div>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={() => void here()}>
          {busy ? "Signing out…" : "Sign out"}
        </button>
        <button type="button" className="tone-solid min-h-11" style={tone("danger")} onClick={onSignOutAll}>
          Sign out of all devices
        </button>
      </div>
    </section>
  );
}
