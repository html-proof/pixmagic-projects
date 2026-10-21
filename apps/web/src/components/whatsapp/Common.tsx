"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { can } from "@app/shared/roles";
import {
  KIND_INFO,
  PARAM_LABEL,
  PARAM_SOURCES,
  previewText,
  reasonLabel,
  templateShape,
  type NotificationKind,
  type ParamSource,
  type TemplateComponent,
  type TemplateMapping,
  type WhatsappConfig,
  type KindSetting,
} from "@app/shared/whatsapp";
import { useApp } from "@/components/AppContext";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { LoadError } from "@/components/LoadError";
import { actionError, api, useApi } from "@/lib/api";

// ---------------------------------------------------------------------------
// Shared pieces of the WhatsApp section: who and where we are, status pills, toasts, a confirm
// dialog, the template picker and its variable mapping.
// ---------------------------------------------------------------------------

/** The current store's WhatsApp API base, and what this member may do. */
export function useWa() {
  const { workspace, store } = useApp();
  const role = workspace.role;
  return {
    ws: workspace.id,
    store,
    base: store ? `/workspaces/${workspace.id}/stores/${store.id}/whatsapp` : null,
    /** Change what customers receive: connect, settings, campaigns, automations, moderation. */
    manage: can(role, "stores:manage"),
    /** See customers' masked numbers, names and their messages. */
    contact: can(role, "customers:contact"),
  };
}

export function WhatsappIcon({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className={className}>
      <path fill="#25D366" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3z" />
      <path
        fill="#fff"
        d="M22.4 18.9c-.3-.2-2-1-2.3-1.1-.3-.1-.5-.2-.8.2-.2.3-.9 1.1-1.1 1.3-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.7-1.7-1-.9-1.7-2-1.9-2.3-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.4.3-.6.1-.2 0-.5 0-.6l-1-2.5c-.3-.7-.6-.6-.8-.6h-.7c-.2 0-.6.1-.9.4-.3.3-1.2 1.2-1.2 2.9s1.2 3.3 1.4 3.6c.2.2 2.4 3.7 5.8 5.1 2.8 1.1 3.4.9 4 .8.6-.1 2-.8 2.3-1.6.3-.8.3-1.5.2-1.6-.1-.1-.3-.2-.6-.4z"
      />
    </svg>
  );
}

const STATUS: Record<string, { tone: Tone; label: string }> = {
  scheduled: { tone: "neutral", label: "Scheduled" },
  sending: { tone: "neutral", label: "Sending" },
  sent: { tone: "good", label: "Sent" },
  delivered: { tone: "good", label: "Delivered" },
  read: { tone: "good", label: "Read" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  skipped: { tone: "warn", label: "Not sent" },
};

/** A message kind in words: a notification's label, or what sent it (campaign, automation, test). */
export const kindLabel = (k: string) =>
  KIND_INFO[k as NotificationKind]?.label ?? ({ automation: "Automation", campaign: "Campaign", test: "Test" } as Record<string, string>)[k] ?? k;

/** A message's status, in words (with the reason as a tooltip when there is one). */
export function MessageStatus({ status, reason }: { status: string; reason?: string | null }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  const why = reasonLabel(reason);
  return (
    <span title={why ?? undefined}>
      <Badge tone={s.tone}>{s.label}</Badge>
    </span>
  );
}

export const TEMPLATE_STATUS: Record<string, { tone: Tone; label: string }> = {
  APPROVED: { tone: "good", label: "Approved" },
  PENDING: { tone: "neutral", label: "In review" },
  IN_APPEAL: { tone: "neutral", label: "In appeal" },
  REJECTED: { tone: "danger", label: "Rejected" },
  PAUSED: { tone: "warn", label: "Paused" },
  DISABLED: { tone: "danger", label: "Disabled" },
};

export const fmtWhen = (iso: string | null | undefined, timeZone?: string) => {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
};

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
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [open, onCancel]);
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

// ---------------------------------------------------------------------------
// Settings and templates
// ---------------------------------------------------------------------------

export interface WaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  qualityScore: string | null;
  components: TemplateComponent[];
  shape: ReturnType<typeof templateShape>;
  updatedAt: string;
}

export interface TemplateCheck {
  state: "ready" | "pending" | "rejected" | "missing" | "unset";
  problem: string | null;
  category: string | null;
}

export interface SettingsResponse {
  enabled: boolean;
  config: WhatsappConfig & { notifications: Record<NotificationKind, KindSetting> };
  checks: Record<NotificationKind, TemplateCheck>;
  basisSetAt: string | null;
  templates: WaTemplate[];
}

/** The store's WhatsApp settings, editable in place, saved as a whole. */
export function useSettings() {
  const { base } = useWa();
  const q = useApi<SettingsResponse>(base ? `${base}/settings` : null);
  const save = useCallback(
    async (config: SettingsResponse["config"]) => {
      if (!base) return;
      await api(`${base}/settings`, { method: "PUT", body: config });
      await q.reload();
    },
    [base, q],
  );
  return { ...q, save };
}

/** A template's body text, with its {{n}} placeholders. */
export const bodyText = (t: WaTemplate | undefined) => t?.components.find((c) => c.type.toUpperCase() === "BODY")?.text ?? "";

/** Example values for previews, per variable source. */
export const EXAMPLE: Record<ParamSource, string> = {
  customer_name: "Asha",
  store_name: "your store",
  order_number: "#1042",
  order_total: "₹1,499.00",
  delivery_address: "12 MG Road, Kochi",
  tracking_url: "https://…/track",
  tracking_token: "(link)",
  courier_name: "Blue Dart",
  tracking_number: "BD123456789IN",
  carrier_tracking_url: "https://courier.example/track",
  estimated_delivery: "2026-10-14",
  review_url: "https://…/review",
  review_token: "(link)",
  checkout_url: "https://…/r/…",
  checkout_link_code: "(link)",
  cart_total: "₹2,500.00",
  refund_amount: "₹499.00",
  campaign_url: "https://…/r/…",
  campaign_link_code: "(link)",
  discount_code: "ONAM20",
  discount_percentage: "20",
  end_date: "15 September",
  occasion: "Happy Onam",
  support_contact: "+91 98765 00000",
  custom_text: "…",
};

/** Choose a template and say what fills each of its variables; shows a live preview. */
export function TemplateMapper({
  templates,
  templateName,
  language,
  mapping,
  onChange,
  category,
  disabled = false,
}: {
  templates: WaTemplate[];
  templateName: string | null;
  language: string;
  mapping: TemplateMapping;
  onChange: (next: { templateName: string | null; language: string; mapping: TemplateMapping }) => void;
  /** Only offer templates of this category (campaigns: MARKETING). */
  category?: "MARKETING" | "UTILITY";
  disabled?: boolean;
}) {
  const id = useId();
  const options = templates.filter((t) => !category || t.category === category);
  const t = templates.find((x) => x.name === templateName && x.language === language);
  const shape = t?.shape;
  const values = (src: ParamSource, pos: string) => (src === "custom_text" ? mapping.fixed[pos] || "…" : EXAMPLE[src]);
  const preview = t ? previewText(bodyText(t), mapping.body.map((s, i) => values(s, `body.${i + 1}`))) : "";
  const setBody = (i: number, src: ParamSource) => {
    const body = [...mapping.body];
    while (body.length <= i) body.push("custom_text");
    body[i] = src;
    onChange({ templateName, language, mapping: { ...mapping, body } });
  };
  const setButton = (i: number, src: ParamSource) => {
    const buttons = [...mapping.buttons];
    while (buttons.length <= i) buttons.push("custom_text");
    buttons[i] = src;
    onChange({ templateName, language, mapping: { ...mapping, buttons } });
  };
  const setFixed = (pos: string, v: string) => onChange({ templateName, language, mapping: { ...mapping, fixed: { ...mapping.fixed, [pos]: v } } });
  return (
    <div className="space-y-3">
      <div>
        <label className="label" htmlFor={`${id}-t`}>
          Template
        </label>
        <select
          id={`${id}-t`}
          className="input"
          disabled={disabled}
          value={templateName ? `${templateName}|${language}` : ""}
          onChange={(e) => {
            const [name, lang] = e.target.value ? e.target.value.split("|") : [null, "en"];
            const next = templates.find((x) => x.name === name && x.language === lang);
            // Keep a mapping that fits; a library template brings its own.
            const fits = next && mapping.body.length >= next.shape.bodyVars;
            onChange({ templateName: name ?? null, language: lang ?? "en", mapping: fits ? mapping : { body: [], buttons: [], fixed: {} } });
          }}
        >
          <option value="">Choose a template…</option>
          {options.map((o) => (
            <option key={o.id} value={`${o.name}|${o.language}`}>
              {o.name} ({o.language}) · {o.category.toLowerCase()} · {TEMPLATE_STATUS[o.status]?.label ?? o.status}
            </option>
          ))}
        </select>
        {!options.length && <p className="mt-1 text-xs text-muted">No {category ? category.toLowerCase() + " " : ""}templates in your WhatsApp account yet. Add them on Message templates.</p>}
      </div>
      {t && shape && (
        <>
          {(shape.bodyVars > 0 || shape.dynamicUrlButtons.length > 0) && (
            <fieldset className="grid gap-2 sm:grid-cols-2" disabled={disabled}>
              <legend className="label">What fills each variable</legend>
              {Array.from({ length: shape.bodyVars }, (_, i) => (
                <VariableRow
                  key={`b${i}`}
                  label={`{{${i + 1}}} in the text`}
                  value={mapping.body[i] ?? "custom_text"}
                  fixed={mapping.fixed[`body.${i + 1}`] ?? ""}
                  onSource={(s) => setBody(i, s)}
                  onFixed={(v) => setFixed(`body.${i + 1}`, v)}
                />
              ))}
              {shape.dynamicUrlButtons.map((_, i) => (
                <VariableRow
                  key={`u${i}`}
                  label="End of the link button"
                  value={mapping.buttons[i] ?? "custom_text"}
                  fixed={mapping.fixed[`button.${i}`] ?? ""}
                  onSource={(s) => setButton(i, s)}
                  onFixed={(v) => setFixed(`button.${i}`, v)}
                />
              ))}
            </fieldset>
          )}
          <div>
            <p className="label">Preview</p>
            <div className="max-w-md whitespace-pre-wrap rounded-2xl rounded-tl-sm border border-border bg-[#e7ffdb] px-4 py-3 text-sm text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
              {preview || "(no text)"}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function VariableRow({ label, value, fixed, onSource, onFixed }: { label: string; value: ParamSource; fixed: string; onSource: (s: ParamSource) => void; onFixed: (v: string) => void }) {
  const id = useId();
  return (
    <div>
      <label className="text-xs text-muted" htmlFor={id}>
        {label}
      </label>
      <select id={id} className="input" value={value} onChange={(e) => onSource(e.target.value as ParamSource)}>
        {PARAM_SOURCES.map((s) => (
          <option key={s} value={s}>
            {PARAM_LABEL[s]}
          </option>
        ))}
      </select>
      {value === "custom_text" && <input className="input mt-1" aria-label={`${label}: fixed text`} value={fixed} maxLength={200} onChange={(e) => onFixed(e.target.value)} placeholder="Text to use" />}
    </div>
  );
}

/** One notification's switch, template and variables. */
export function KindEditor({
  kind,
  setting,
  check,
  templates,
  manage,
  onChange,
}: {
  kind: NotificationKind;
  setting: KindSetting;
  check: TemplateCheck | undefined;
  templates: WaTemplate[];
  manage: boolean;
  onChange: (s: KindSetting) => void;
}) {
  const info = KIND_INFO[kind];
  const [open, setOpen] = useState(false);
  const tone: Tone = !setting.enabled ? "neutral" : check?.state === "ready" ? "good" : check?.state === "pending" ? "neutral" : "warn";
  const label = !setting.enabled ? "Off" : check?.state === "ready" ? "On" : check?.state === "pending" ? "On · template in review" : "On · needs attention";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {info.label} <Badge tone={tone}>{label}</Badge>
          </p>
          <p className="text-xs text-muted">{info.when}</p>
          {setting.enabled && check?.problem && <p className="mt-1 text-xs text-warn">{check.problem}</p>}
          {setting.templateName && <p className="mt-0.5 text-xs text-muted">Template: {setting.templateName} ({setting.language})</p>}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Close" : manage ? "Edit" : "Details"}
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={setting.enabled}
              disabled={!manage}
              onChange={() => {
                if (!setting.enabled && !setting.templateName) setOpen(true);
                onChange({ ...setting, enabled: !setting.enabled });
              }}
            />
            <span className="sr-only">Send {info.label.toLowerCase()} messages</span>
          </label>
        </div>
      </div>
      {open && (
        <div className="mt-3 rounded-lg border border-border bg-bg/50 p-3">
          <TemplateMapper
            templates={templates}
            templateName={setting.templateName}
            language={setting.language}
            mapping={setting.mapping}
            disabled={!manage}
            onChange={(n) => onChange({ ...setting, ...n })}
          />
        </div>
      )}
    </li>
  );
}

/** A section of notification kinds with one Save button. */
export function KindsSection({ title, help, kinds, extra }: { title: string; help?: ReactNode; kinds: NotificationKind[]; extra?: (cfg: SettingsResponse["config"], set: (c: SettingsResponse["config"]) => void) => ReactNode }) {
  const { manage } = useWa();
  const { data, error, save, reload } = useSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<SettingsResponse["config"] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setDraft(data.config);
  }, [data]);
  if (error) return <LoadError what="notification settings" error={error} onRetry={() => void reload()} />;
  if (!data || !draft) return <Skeleton lines={4} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const onSave = async () => {
    setBusy(true);
    try {
      await save(draft);
      toast("success", "Saved.");
    } catch (e) {
      toast("error", actionError(e, "save"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card animate-rise" aria-label={title}>
      <h2 className="font-semibold">{title}</h2>
      {help && <div className="mt-1 text-sm text-muted">{help}</div>}
      <ul className="mt-2 divide-y divide-border">
        {kinds.map((k) => (
          <KindEditor
            key={k}
            kind={k}
            setting={draft.notifications[k]}
            check={dirty ? undefined : data.checks[k]}
            templates={data.templates}
            manage={manage}
            onChange={(s) => setDraft({ ...draft, notifications: { ...draft.notifications, [k]: s } })}
          />
        ))}
      </ul>
      {extra?.(draft, setDraft)}
      {manage && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!dirty || busy} onClick={() => void onSave()}>
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && (
            <button type="button" className="btn-secondary" onClick={() => setDraft(data.config)} disabled={busy}>
              Discard changes
            </button>
          )}
          {draft.transactionalBasis === "none" && kinds.some((k) => !k.startsWith("abandoned")) && (
            <p className="text-xs text-warn">Nothing is sent until you choose how customers agree to WhatsApp updates in WhatsApp → Settings.</p>
          )}
        </div>
      )}
    </section>
  );
}
