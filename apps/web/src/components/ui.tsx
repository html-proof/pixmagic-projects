import type { ReactNode } from "react";
import Link from "next/link";
import { StateIllustration } from "@/components/StateIllustration";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <p className="mb-6 text-sm font-semibold tracking-wide text-accent">Insights</p>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      <div className="mt-6 space-y-4">{children}</div>
      {/*
        Several failures on these pages tell the merchant to "contact support", and the Shopify
        listing has to link a privacy policy, so both live on every auth and install screen.
      */}
      <p className="mt-10 text-xs text-muted">
        <Link className="underline" href="/support">Support</Link>
        {" · "}
        <Link className="underline" href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success"; children: ReactNode }) {
  const color = kind === "error" ? "border-danger text-danger" : kind === "success" ? "border-good text-good" : "border-border text-muted";
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${color}`}>
      {children}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div role="status" className="card flex flex-col items-center gap-3 px-5 py-10 text-center sm:py-14">
      <StateIllustration kind="empty" />
      <h3 className="text-xl font-semibold">{title}</h3>
      <p className="max-w-md text-sm leading-relaxed text-muted">{body}</p>
      {action}
    </div>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
