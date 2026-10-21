"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { actionError, api, ApiError, isSignedOut } from "@/lib/api";
import { setReturnTo } from "@/lib/returnTo";
import { WORKSPACE_KEY, writeLocal } from "@/lib/storage";
import { ErrorState } from "@/components/ErrorState";
import { Alert, AuthShell } from "@/components/ui";

function Invite() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const [reference, setReference] = useState<string | undefined>();
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const { workspaceId } = await api<{ workspaceId: string }>("/invitations/accept", { method: "POST", body: { token } });
      // Open the workspace they just joined, not whichever one the app had selected before.
      writeLocal(WORKSPACE_KEY, workspaceId);
      router.replace("/dashboard");
    } catch (e) {
      // Signed out: come back here after signing in. Sending them to /login alone lost the
      // invitation, and a new invitee then set up a workspace of their own instead of joining.
      if (isSignedOut(e)) {
        setReturnTo(`/invite?token=${encodeURIComponent(token)}`);
        router.push("/login");
        return;
      }
      if (e instanceof ApiError && e.code === "invalid_invite") { setExpired(true); setReference(e.correlationId); }
      setError(actionError(e, "accept the invitation"));
      setBusy(false);
    }
  }

  if (!token || expired) return <main className="px-4"><ErrorState kind="invite" correlationId={reference} fullPage /></main>;

  return (
    <AuthShell title="Join workspace" subtitle="Sign in with the email address the invitation was sent to, then accept.">
      {error && <Alert>{error}</Alert>}
      <button className="btn-primary w-full" onClick={accept} disabled={busy || !token}>{busy ? "Joining…" : "Accept invitation"}</button>
    </AuthShell>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <Invite />
    </Suspense>
  );
}
