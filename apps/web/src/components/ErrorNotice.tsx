import type { ReactNode } from "react";
import { StateIllustration } from "@/components/StateIllustration";
import { safeCorrelationId } from "@/lib/apiClient";
export function ErrorNotice({ kind, title, children, action, correlationId }: {
  kind: "network" | "sync" | "validation" | "integration"; title: string; children: ReactNode; action?: ReactNode; correlationId?: string;
}) {
  const reference = safeCorrelationId(correlationId);
  return <div role={kind === "validation" ? "alert" : "status"} className="flex flex-col items-center gap-3 rounded-xl border border-border bg-surface p-4 text-center sm:flex-row sm:text-left">
    <StateIllustration kind={kind} compact />
    <div className="min-w-0 flex-1"><p className="font-semibold text-text">{title}</p><div className="mt-1 text-sm leading-relaxed text-muted">{children}</div>
      {reference && <p className="mt-2 break-all text-xs text-muted">Support reference: {reference}</p>}
    </div>
    {action && <div className="shrink-0">{action}</div>}
  </div>;
}
