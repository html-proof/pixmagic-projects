"use client";
import Link from "next/link";
import { StateIllustration } from "@/components/StateIllustration";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, CalendarClock, ShieldCheck, UserRound } from "lucide-react";
import type { Role } from "@app/shared/roles";
import { actionError, api, ApiError, isSignedOut, setSharedTab } from "@/lib/api";
import { landingPath } from "@/lib/access";
import { setReturnTo } from "@/lib/returnTo";
import { Alert } from "@/components/ui";
import { AuthCard, AuthSubmit } from "@/components/auth/AuthCard";

interface Preview {
  status: "pending" | "accepted" | "revoked" | "expired" | "invalid";
  /** Accepted already, and the link still opens the dashboard. */
  reopens?: boolean;
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
  // Moved out of the address bar before the page's scripts ran (invite/layout.tsx).
  let stashed: string | null = null;
  try {
    stashed = sessionStorage.getItem("bi:invite-token");
    sessionStorage.removeItem("bi:invite-token");
  } catch {
    /* storage blocked: the fragment is still in the address bar */
  }
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("token");
  const token = stashed ?? hash ?? new URLSearchParams(window.location.search).get("token") ?? "";
  if (hash || window.location.search.includes("token=")) window.history.replaceState(null, "", "/invite");
  return token;
}

const ENDED: Record<Exclude<Preview["status"], "pending">, { title: string; body: string }> = {
  accepted: { title: "This link has ended", body: "This invitation link no longer opens the dashboard: the access it gave has ended or was taken back. Ask the person who shared it with you." },
  revoked: { title: "Invitation cancelled", body: "This invitation was cancelled, so its link no longer works. Ask the person who invited you for a new one." },
  expired: { title: "Invitation expired", body: "This invitation has expired. Ask the person who invited you to renew it: the same link will work again." },
  invalid: { title: "This link doesn't work", body: "The invitation link isn't valid. Check you opened the whole link from the email, or ask for a new invitation." },
};

/** Whose dashboard, from whom, what of it, for whom: shown while it opens and when it can't. */
function Shared({ preview }: { preview: Preview }) {
  return (
    <ul className="space-y-3 text-sm" data-testid="invite-details">
      <li className="flex gap-3">
        <Building2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <span>
          <span className="font-medium">{preview.workspace}</span>
          {preview.inviter && <span className="text-muted">, shared by {preview.inviter}</span>}
        </span>
      </li>
      <li className="flex gap-3">
        <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <span>
          As <span className="font-medium">{preview.roleLabel}</span>: {preview.modules?.length ? preview.modules.join(" • ") : "nothing yet"}
        </span>
      </li>
      {preview.email && (
        <li className="flex gap-3">
          <UserRound aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>For {preview.email}</span>
        </li>
      )}
      {preview.expiresAt && (
        <li className="flex gap-3">
          <CalendarClock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>Access until {new Date(preview.expiresAt).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}</span>
        </li>
      )}
    </ul>
  );
}

/**
 * The invitation link. Opening it opens the shared dashboard: no account, password or sign-up.
 * The page asks the API to open it (POST /invitations/open) as soon as it loads, which gives this
 * browser a view-only session for the shared workspace only, in a cookie of its own: an account
 * signed in on this browser stays signed in, untouched, in its other tabs. This tab then shows the
 * shared dashboard (setSharedTab) from the first page shared with them. The link keeps working
 * (another device, later) until its end date, unless the owner takes the access away. For an
 * address that already has a bizinsights account, the link alone doesn't join it: the person
 * accepts signed in to that account (accept).
 */
export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The invited address has an account: it accepts signed in (POST /invitations/accept). */
  const [signIn, setSignIn] = useState(false);
  const started = useRef(false);

  /** Into the workspace, on the first page this member may see there. */
  const goTo = useCallback(
    async (workspaceId: string) => {
      const access = await api<{ role: Role; permissions: string[]; staffRole: null }>(`/workspaces/${workspaceId}/access`).catch(() => null);
      router.replace(access ? landingPath({ role: access.role, permissions: access.permissions }, access.staffRole) : "/dashboard");
    },
    [router],
  );

  /**
   * The invited address has an account of its own: it accepts signed in as itself, never through
   * the link alone. Accepted at once when this browser is signed in to it; signed out, the page
   * offers to sign in and come back here.
   */
  const accept = useCallback(
    async (t: string): Promise<"accepted" | "signed_out" | "refused"> => {
      // As the account signed in on this browser, never a shared-link session this tab had before.
      setSharedTab(false);
      try {
        const r = await api<{ workspaceId: string }>("/invitations/accept", { method: "POST", body: { token: t } });
        await goTo(r.workspaceId);
        return "accepted";
      } catch (e) {
        if (isSignedOut(e)) return "signed_out";
        // Signed in as someone else, say: its message says whose invitation it is.
        setError(actionError(e, "accept the invitation"));
        return "refused";
      }
    },
    [goTo],
  );

  const open = useCallback(
    async (t: string) => {
      setBusy(true);
      setError(null);
      try {
        const r = await api<{ workspaceId: string }>("/invitations/open", { method: "POST", body: { token: t } });
        setSharedTab(true);
        await goTo(r.workspaceId);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : "";
        const signedIn = code === "sign_in_required" ? await accept(t) : null;
        if (signedIn === "accepted") return;
        if (signedIn !== "refused") setError(actionError(e, "open the shared dashboard"));
        setSignIn(signedIn === "signed_out" || code === "account_unverified");
        setBusy(false);
      }
    },
    [goTo, accept],
  );

  /** To sign in and back: the token waits in this tab's sessionStorage (as the layout keeps it), never in the address bar or localStorage. */
  function signInHere() {
    try {
      sessionStorage.setItem("bi:invite-token", token);
    } catch {
      /* storage blocked: back here, the page asks to open the link from the email again */
    }
    setReturnTo("/invite");
    router.push("/login");
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const t = readToken();
    setToken(t);
    if (!t) return setPreview({ status: "invalid" });
    api<Preview>("/invitations/preview", { method: "POST", body: { token: t } }).then(
      (p) => {
        setPreview(p);
        if (p.status === "pending" || p.reopens) void open(t);
      },
      (e: unknown) => setError(actionError(e, "open the invitation")),
    );
  }, [open]);

  if (!preview) {
    return (
      <AuthCard title="Opening the shared dashboard…">
        {error ? <Alert>{error}</Alert> : <p className="text-muted" role="status">Checking the invitation link…</p>}
      </AuthCard>
    );
  }

  if (preview.status !== "pending" && !preview.reopens) {
    const e = ENDED[preview.status];
    return (
      <AuthCard title={e.title} subtitle={preview.workspace ? `${preview.workspace}${preview.inviter ? `, shared by ${preview.inviter}` : ""}` : undefined}>
        <StateIllustration kind="invite" compact />
        <Alert kind="error">{e.body}</Alert>
        {preview.status === "accepted" && (
          <Link prefetch={false} className="btn-secondary w-full" href="/login">
            Sign in to your account
          </Link>
        )}
      </AuthCard>
    );
  }

  return (
    <AuthCard title={`${preview.workspace}`} subtitle="A business dashboard shared with you">
      <Shared preview={preview} />
      {preview.message && <blockquote className="whitespace-pre-wrap rounded-lg border-l-4 border-accent bg-accent/[0.06] px-4 py-3 text-sm">{preview.message}</blockquote>}
      {error && signIn ? (
        <>
          <Alert kind="info">{error}</Alert>
          <AuthSubmit type="button" onClick={signInHere} data-testid="invite-sign-in">
            Sign in to accept
          </AuthSubmit>
        </>
      ) : error ? (
        <>
          <Alert>{error}</Alert>
          <AuthSubmit type="button" onClick={() => void open(token)} busy={busy} busyLabel="Opening…">
            Try again
          </AuthSubmit>
        </>
      ) : (
        <p className="text-sm text-muted" role="status" data-testid="invite-opening">
          Opening the dashboard…
        </p>
      )}
      {!signIn && <p className="text-xs text-muted">No account or password needed, and it&apos;s view-only. If you weren&apos;t expecting this, you can close this page.</p>}
    </AuthCard>
  );
}
