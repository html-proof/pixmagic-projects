"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarX2, LinkIcon, LockKeyhole, ShieldOff } from "lucide-react";
import { BrandLogo } from "@/components/Brand";
import { leaveSharedSession, setSharedTab } from "@/lib/api";
import { leaveTo, signOut } from "@/lib/auth";

// ---------------------------------------------------------------------------
// What a member sees when a workspace grants them nothing: access revoked by an owner or admin
// (the whole app), or no permissions chosen yet (the dashboard). Neither shows any business data.
// ---------------------------------------------------------------------------

/**
 * Leave a shared dashboard: its shared-link session ends (an account signed in on this browser
 * stays signed in: leaveSharedSession), and the tab goes to the homepage, which sends a signed-in
 * browser on to its own dashboard.
 */
export async function closeSharedDashboard(router: { replace(href: string): void }) {
  await leaveSharedSession();
  router.replace("/");
}

/**
 * Full page, outside the app's frame: their access to `workspace` was revoked, or (`expired`) the
 * access an invitation gave them reached its end date. Nothing of the workspace is shown.
 */
export function AccessRevoked({
  workspace,
  others,
  onSwitch,
  reason = "revoked",
  shared = false,
}: {
  workspace: string;
  others: Array<{ id: string; name: string }>;
  onSwitch(id: string): void;
  reason?: "revoked" | "expired";
  shared?: boolean;
}) {
  const router = useRouter();
  const expired = reason === "expired";
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-12" data-testid={expired ? "access-expired" : "access-revoked"}>
      <p className="mb-8">
        <BrandLogo size={26} className="text-lg" />
      </p>
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        {expired ? <CalendarX2 className="h-6 w-6" strokeWidth={1.8} /> : <ShieldOff className="h-6 w-6" strokeWidth={1.8} />}
      </span>
      <h1 className="mt-4 text-2xl font-semibold">{expired ? "Your shared access has ended" : "Your access was revoked"}</h1>
      <p className="mt-2 text-muted">
        {expired ? (
          <>
            The access <strong className="text-text">{workspace}</strong> shared with you has reached its end date, so its dashboard is no longer available. If you still need it, ask
            the person who shared it to renew your access: the same link will work again.
          </>
        ) : (
          <>
            An owner or admin of <strong className="text-text">{workspace}</strong> has revoked your access, so you can no longer see its dashboard. If you still need it, ask them to
            restore it.
          </>
        )}
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {others.map((w) => (
          <button key={w.id} type="button" className="btn-primary" onClick={() => onSwitch(w.id)}>
            Open {w.name}
          </button>
        ))}
        {shared ? (
          <button type="button" className="btn-secondary" onClick={() => void closeSharedDashboard(router)}>
            Close the shared dashboard
          </button>
        ) : (
          <button type="button" className="btn-secondary" onClick={async () => leaveTo(await signOut(), router)}>
            Sign out
          </button>
        )}
      </div>
    </main>
  );
}

/** Full page: this tab showed a shared dashboard and its shared-link session is gone (it ended with the link, or was closed in another tab). */
export function SharedLinkEnded() {
  const router = useRouter();
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-12" data-testid="shared-link-ended">
      <p className="mb-8">
        <BrandLogo size={26} className="text-lg" />
      </p>
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
        <LinkIcon className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <h1 className="mt-4 text-2xl font-semibold">This shared dashboard has closed</h1>
      <p className="mt-2 text-muted">
        The dashboard was opened from an invitation link, and that session has ended. To see it again, open the link from your invitation email. If the link no longer works, ask the
        person who shared it with you.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setSharedTab(false);
            router.replace("/login");
          }}
        >
          Sign in to your own account
        </button>
      </div>
    </main>
  );
}

/** On the dashboard: a member whose role has no permissions chosen yet. */
export function NoAccessAssigned({ workspace, role }: { workspace: string; role: string }) {
  return (
    <section className="card mx-auto max-w-xl text-center" data-testid="no-access" aria-labelledby="no-access-h">
      <span aria-hidden className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 text-accent">
        <LockKeyhole className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <h1 id="no-access-h" className="mt-4 text-xl font-semibold">No access assigned</h1>
      <p className="mt-2 text-sm text-muted">
        You&apos;re a member of <strong className="text-text">{workspace}</strong> as {role}, but no information has been shared with you yet. Ask an owner or admin of the workspace to
        choose what you can see. This page updates by itself once they do.
      </p>
      <p className="mt-4">
        <Link href="/settings/profile" className="btn-secondary">
          My account
        </Link>
      </p>
    </section>
  );
}
