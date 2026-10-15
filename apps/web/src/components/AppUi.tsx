"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { actionError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Pieces every signed-in area uses (WhatsApp, Email, Staff, the employee portal): the page header,
// the loading skeleton, toasts, actions with feedback, and a confirm dialog.
// ---------------------------------------------------------------------------

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card animate-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="card space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton h-5" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto animate-rise flex max-w-md items-start gap-2 rounded-lg border bg-surface px-4 py-3 text-sm shadow-lg ${t.kind === "error" ? "border-danger text-danger" : t.kind === "success" ? "border-good" : "border-border"}`}
          >
            <span className="min-w-0 flex-1 text-text">{t.text}</span>
            <button type="button" className="text-muted hover:text-text" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Run an action with a toast for its outcome. Resolves true on success. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async (key: string, what: string, fn: () => Promise<string | void>) => {
      setBusy(key);
      try {
        const msg = await fn();
        if (msg) toast("success", msg);
        return true;
      } catch (e) {
        toast("error", actionError(e, what));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

/**
 * Dialogs and drawers render on document.body: the cards' entrance animation (animate-rise, fill
 * mode both) keeps a transform in effect, which makes a card the containing block of any
 * position: fixed element inside it, so an overlay drawn in place covers only its card.
 */
export const overlay = (node: ReactNode) => (typeof document === "undefined" ? node : createPortal(node, document.body));

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  // Read the latest onCancel at key time, so focus moves only when the dialog opens and not on every
  // parent re-render that passes a new callback (pages with a ticking clock re-render each second).
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open]);
  if (!open) return null;
  return overlay(
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onCancel}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className="card animate-sheet w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        <div className="mt-2 space-y-2 text-sm text-muted">{children}</div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
