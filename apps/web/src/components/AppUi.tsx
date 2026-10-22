"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { actionError } from "@/lib/api";

// ---------------------------------------------------------------------------
// Pieces every signed-in area uses (WhatsApp, Email, Staff, the employee portal): a section's side
// menu, the page header, the loading skeleton, toasts, actions with feedback, and a confirm dialog.
// ---------------------------------------------------------------------------

/**
 * A section with a menu of its own (Staff Management, WhatsApp): the menu down the left from tablet
 * width, a row of links that scrolls sideways above the page on phones.
 */
export function SectionLayout({ title, icon, items, children }: { title: string; icon: ReactNode; items: ReadonlyArray<{ href: string; label: string; active: boolean }>; children: ReactNode }) {
  return (
    <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
      <nav aria-label={title} className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:pb-0">
        <p className="mb-2 hidden items-center gap-2 px-3 text-sm font-semibold md:flex">
          {icon}
          {title}
        </p>
        {items.map(({ href, label, active }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm transition ${active ? "bg-surface font-semibold shadow-sm" : "text-muted hover:text-text"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 space-y-4">{children}</div>
    </div>
  );
}

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
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Something is under way: both buttons wait, and the confirm button says so. */
  busy?: boolean;
  /** Not ready to confirm yet (a field to fill in): only the confirm button waits; Cancel still works. */
  confirmDisabled?: boolean;
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
    // A field to fill in comes first; otherwise the first button (Cancel).
    (ref.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ?? ref.current?.querySelector<HTMLElement>("button"))?.focus();
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
        {/* A form, so Enter in a field confirms like the button does. */}
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !confirmDisabled) onConfirm();
          }}
        >
          <div className="mt-2 space-y-2 text-sm text-muted">{children}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={danger ? "btn-danger" : "btn-primary"} disabled={busy || confirmDisabled}>
              {busy ? "Working…" : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * A dialog with content of its own (a form, or a form in steps), closed by its X, Escape or a click
 * outside. Focus goes to its first field (or its first button) and back where it was when it
 * closes. ConfirmDialog is the yes-or-no one.
 */
export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    (body.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ?? body.current?.querySelector<HTMLElement>("button, a[href]") ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A confirm dialog opened on top handles its own Escape.
      if (e.key === "Escape" && !e.defaultPrevented && ref.current?.contains(document.activeElement)) close.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open]);
  if (!open) return null;
  return overlay(
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className="card animate-sheet max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={id} className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="-m-1.5 grid size-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-bg hover:text-text">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div ref={body} className="mt-3">
          {children}
        </div>
      </div>
    </div>,
  );
}
