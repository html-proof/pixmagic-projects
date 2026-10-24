"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutDashboard, LockKeyhole, LogIn, LogOut, X } from "lucide-react";
import { ErrorPanel } from "@/components/ErrorState";
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
 * Full page, in the error pages' frame and card (ErrorPanel), outside the app's: their access to
 * `workspace` was revoked, or (`expired`) the access an invitation gave them reached its end date.
 * Nothing of the workspace is shown.
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
  // The way out is the main button when there's no other workspace to open.
  const leave = `${others.length ? "btn-secondary" : "btn-primary"} px-5 py-2.5`;
  return (
    <div data-testid={expired ? "access-expired" : "access-revoked"}>
      <ErrorPanel
        kind={expired ? "invite" : "forbidden"}
        code={expired ? "Access ended" : "Access revoked"}
        title={expired ? "Your shared access has ended" : "Your access was revoked"}
        body={
          expired ? (
            <>
              The access <strong className="text-text">{workspace}</strong> shared with you has reached its end date, so its dashboard is no longer available. If you still need it,
              ask the person who shared it to renew your access: the same link will work again.
            </>
          ) : (
            <>
              An owner or admin of <strong className="text-text">{workspace}</strong> has revoked your access, so you can no longer see its dashboard. If you still need it, ask them
              to restore it.
            </>
          )
        }
        fullPage
      >
        {others.map((w) => (
          <button key={w.id} type="button" className="btn-primary px-5 py-2.5" onClick={() => onSwitch(w.id)}>
            <LayoutDashboard aria-hidden className="size-4" />
            Open {w.name}
          </button>
        ))}
        {shared ? (
          <button type="button" className={leave} onClick={() => void closeSharedDashboard(router)}>
            <X aria-hidden className="size-4" />
            Close the shared dashboard
          </button>
        ) : (
          <button type="button" className={leave} onClick={async () => leaveTo(await signOut(), router)}>
            <LogOut aria-hidden className="size-4" />
            Sign out
          </button>
        )}
      </ErrorPanel>
    </div>
  );
}

/** Full page: this tab showed a shared dashboard and its shared-link session is gone (it ended with the link, or was closed in another tab). */
export function SharedLinkEnded() {
  const router = useRouter();
  return (
    <div data-testid="shared-link-ended">
      <ErrorPanel
        kind="session"
        code="Link closed"
        title="This shared dashboard has closed"
        body="The dashboard was opened from an invitation link, and that session has ended. To see it again, open the link from your invitation email. If the link no longer works, ask the person who shared it with you."
        fullPage
      >
        <button
          type="button"
          className="btn-primary px-5 py-2.5"
          onClick={() => {
            setSharedTab(false);
            router.replace("/login");
          }}
        >
          <LogIn aria-hidden className="size-4" />
          Sign in to your own account
        </button>
      </ErrorPanel>
    </div>
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
