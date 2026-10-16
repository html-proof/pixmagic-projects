"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKeyhole, ShieldOff } from "lucide-react";
import { BrandLogo } from "@/components/Brand";
import { leaveTo, signOut } from "@/lib/auth";

// ---------------------------------------------------------------------------
// What a member sees when a workspace grants them nothing: access revoked by an owner or admin
// (the whole app), or no permissions chosen yet (the dashboard). Neither shows any business data.
// ---------------------------------------------------------------------------

/** Full page, outside the app's frame: their access to `workspace` was revoked. */
export function AccessRevoked({ workspace, others, onSwitch }: { workspace: string; others: Array<{ id: string; name: string }>; onSwitch(id: string): void }) {
  const router = useRouter();
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-12" data-testid="access-revoked">
      <p className="mb-8">
        <BrandLogo size={26} className="text-lg" />
      </p>
      <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
        <ShieldOff className="h-6 w-6" strokeWidth={1.8} />
      </span>
      <h1 className="mt-4 text-2xl font-semibold">Your access was revoked</h1>
      <p className="mt-2 text-muted">
        An owner or admin of <strong className="text-text">{workspace}</strong> has revoked your access, so you can no longer see its dashboard. If you still need it, ask them to restore
        it.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {others.map((w) => (
          <button key={w.id} type="button" className="btn-primary" onClick={() => onSwitch(w.id)}>
            Open {w.name}
          </button>
        ))}
        <button type="button" className="btn-secondary" onClick={async () => leaveTo(await signOut(), router)}>
          Sign out
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
