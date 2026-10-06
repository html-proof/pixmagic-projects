"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { Alert, AuthShell } from "@/components/ui";

function Invite() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    try {
      await api("/invitations/accept", { method: "POST", body: { token } });
      router.replace("/dashboard");
    } catch (e) {
      const err = e as { status?: number; message: string };
      if (err.status === 401) router.push(`/login`);
      else setError(err.message);
    }
  }

  return (
    <AuthShell title="Join workspace" subtitle="Sign in with the email address the invitation was sent to, then accept.">
      {error && <Alert>{error}</Alert>}
      <button className="btn-primary w-full" onClick={accept}>Accept invitation</button>
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
