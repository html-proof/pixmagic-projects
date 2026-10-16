"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CalendarClock, Building2, ShieldCheck, UserRound } from "lucide-react";
import type { Role } from "@app/shared/roles";
import { actionError, api, ApiError } from "@/lib/api";
import { landingPath } from "@/lib/access";
import { leaveTo, signOut } from "@/lib/auth";
import { setReturnTo } from "@/lib/returnTo";
import { WORKSPACE_KEY, writeLocal } from "@/lib/storage";
import { Alert } from "@/components/ui";
import { AuthCard, AuthSubmit } from "@/components/auth/AuthCard";

interface Preview {
  status: "pending" | "accepted" | "revoked" | "expired" | "invalid";
  workspace?: string;
  inviter?: string | null;
  role?: Role;
  roleLabel?: string;
  modules?: string[];
  permissionCount?: number;
  message?: string | null;
  expiresAt?: string;
  email?: string;
}

/**
 * The token: after `#token=` in links from now on (browsers never send the fragment to a server, so
 * it stays out of logs), or `?token=` in links sent before.
 */
function readToken(): string {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  return hash ?? new URLSearchParams(window.location.search).get("token") ?? "";
}

const ENDED: Record<Exclude<Preview["status"], "pending">, { title: string; body: string }> = {
  accepted: { title: "Invitation already used", body: "This invitation has been accepted. If that was you, open your dashboard; otherwise ask for a new invitation." },
  revoked: { title: "Invitation cancelled", body: "This invitation was cancelled, so its link no longer works. Ask the person who invited you for a new one." },
  expired: { title: "Invitation expired", body: "This invitation has expired. Ask the person who invited you to send it again." },
  invalid: { title: "This link doesn't work", body: "The invitation link isn't valid. Check you opened the whole link from the email, or ask for a new invitation." },
};

export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [who, setWho] = useState<{ email: string } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = readToken();
    setToken(t);
    if (!t) return setPreview({ status: "invalid" });
    api<Preview>("/invitations/preview", { method: "POST", body: { token: t } }).then(setPreview, (e: unknown) => setError(actionError(e, "open the invitation")));
    api<{ user: { email: string } | null }>("/auth/whoami").then(
      (r) => setWho(r.user),
      () => setWho(null),
    );
  }, []);

  const here = token ? `/invite#token=${encodeURIComponent(token)}` : "/invite";
  const toSignIn = (path: "/login" | "/signup") => {
    // Back here after signing in or creating the account, to accept.
    setReturnTo(here);
    router.push(path);
  };

  async function accept() {
    if (!token) return;
    setBusy(true);
    setError(null);
    setMismatch(false);
    try {
      const { workspaceId } = await api<{ workspaceId: string }>("/invitations/accept", { method: "POST", body: { token } });
      // Open the workspace they just joined, on the first page they may see there.
      writeLocal(WORKSPACE_KEY, workspaceId);
      const access = await api<{ role: Role; permissions: string[]; staffRole: null }>(`/workspaces/${workspaceId}/access`).catch(() => null);
      router.replace(access ? landingPath({ role: access.role, permissions: access.permissions }, access.staffRole) : "/dashboard");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return toSignIn("/login");
      if (e instanceof ApiError && e.code === "invite_email_mismatch") setMismatch(true);
      setError(actionError(e, "accept the invitation"));
      setBusy(false);
    }
  }

  async function switchAccount() {
    setReturnTo(here);
    leaveTo(await signOut(), router);
  }

  if (!preview) {
    return (
      <AuthCard title="Opening your invitation…">
        {error ? <Alert>{error}</Alert> : <p className="text-muted" role="status">Checking the invitation link…</p>}
      </AuthCard>
    );
  }

  if (preview.status !== "pending") {
    const e = ENDED[preview.status];
    return (
      <AuthCard title={e.title} subtitle={preview.workspace ? `${preview.workspace}${preview.inviter ? `, invited by ${preview.inviter}` : ""}` : undefined}>
        <Alert kind={preview.status === "accepted" ? "info" : "error"}>{e.body}</Alert>
        {preview.status === "accepted" && (
          <Link className="btn-primary w-full" href="/dashboard">
            Open my dashboard
          </Link>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`Join ${preview.workspace}`} subtitle="You've been invited to access a shared business dashboard.">
      <ul className="space-y-3 text-sm" data-testid="invite-details">
        <li className="flex gap-3">
          <Building2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            <span className="font-medium">{preview.workspace}</span>
            {preview.inviter && <span className="text-muted">, invited by {preview.inviter}</span>}
          </span>
        </li>
        <li className="flex gap-3">
          <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            As <span className="font-medium">{preview.roleLabel}</span>: {preview.modules?.length ? preview.modules.join(" • ") : "nothing yet (they'll choose)"}
          </span>
        </li>
        <li className="flex gap-3">
          <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>For {preview.email}</span>
        </li>
        {preview.expiresAt && (
          <li className="flex gap-3">
            <CalendarClock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <span>Expires {new Date(preview.expiresAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</span>
          </li>
        )}
      </ul>
      {preview.message && <blockquote className="whitespace-pre-wrap rounded-lg border-l-4 border-accent bg-accent/[0.06] px-4 py-3 text-sm">{preview.message}</blockquote>}
      {error && <Alert>{error}</Alert>}
      {who === undefined ? (
        <p className="text-sm text-muted">Checking whether you&apos;re signed in…</p>
      ) : who ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Signed in as <span className="font-medium text-text">{who.email}</span>.
          </p>
          <AuthSubmit type="button" onClick={accept} busy={busy} busyLabel="Joining…">
            Accept invitation
          </AuthSubmit>
          {mismatch && (
            <button type="button" className="btn-secondary w-full" onClick={switchAccount}>
              Sign in with another account
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Sign in, or create an account, with the email address this invitation was sent to. You don&apos;t need a Shopify store of your own.</p>
          <AuthSubmit type="button" onClick={() => toSignIn("/login")}>
            Sign in to accept
          </AuthSubmit>
          <button type="button" className="btn-secondary w-full" onClick={() => toSignIn("/signup")}>
            Create an account
          </button>
        </div>
      )}
      <p className="text-xs text-muted">If you weren&apos;t expecting this invitation, you can safely ignore it.</p>
    </AuthCard>
  );
}
