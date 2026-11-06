"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { useToast } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { Dot, type Tone } from "@/components/dashboard/Primitives";
import { fmtRelative } from "@/components/dashboard/format";
import { actionError, api, ApiError, fmtNum, useLiveApi } from "@/lib/api";
import type { StatusAnswer, StockSource } from "@/lib/inventory";
import { scopeList } from "@app/shared/capabilities";
import { STOCK_STATUS_INFO, type StockStatus } from "@app/shared/inventory";

// ---------------------------------------------------------------------------
// What every Inventory page shares: the store's inventory status (where the stock comes from, when
// it last matched Shopify, what this member may do), the status pill and Refresh in each page's
// header (the Stitch design's "In step with Shopify · checked 4 h ago"), the "connect stock levels"
// card, status words and quantities.
// ---------------------------------------------------------------------------

interface InventoryCtx {
  base: string;
  status: StatusAnswer | null;
  error: ApiError | null;
  loading: boolean;
  /** Ask again now (after a refresh or a change of access). */
  refresh: () => void;
}

const Ctx = createContext<InventoryCtx | null>(null);

export function InventoryProvider({ storeId, children }: { storeId: string; children: ReactNode }) {
  const { workspace } = useApp();
  const base = `/workspaces/${workspace.id}/stores/${storeId}/inventory`;
  const [bump, setBump] = useState(0);
  const [fast, setFast] = useState(false);
  const live = useLiveApi<StatusAnswer>(`${base}/status${bump ? `?n=${bump}` : ""}`, fast ? 5_000 : 30_000);
  const running = live.data?.status.running ?? false;
  if (running !== fast) setFast(running);
  const refresh = useCallback(() => setBump((n) => n + 1), []);
  const value = useMemo(() => ({ base, status: live.data, error: live.error, loading: live.loading, refresh }), [base, live.data, live.error, live.loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useInventory(): InventoryCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useInventory outside InventoryProvider");
  return c;
}

/**
 * Whether this member may change stock here: the permission (inventory.adjust), stock levels read
 * per location, and the store's grant to change stock in Shopify. Each item must also be tracked.
 */
export function useCanAdjust(): boolean {
  const { status } = useInventory();
  return !!status?.can.adjust && status.status.source === "levels" && !!status.capabilities.find((c) => c.id === "stock_adjustments")?.enabled;
}

// ---------------------------------------------------------------------------
// Status and quantities
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<StockStatus, Tone> = { in_stock: "good", low: "warn", out: "danger", untracked: "neutral" };
const STATUS_TEXT: Record<StockStatus, string> = { in_stock: "text-good", low: "text-warn", out: "text-danger", untracked: "text-muted" };

/** A status as the design's screen 22 writes it: the words in the status's colour, with its dot. */
export function StockBadge({ status }: { status: StockStatus | null }) {
  if (!status) return <span className="text-xs text-muted">—</span>;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ${STATUS_TEXT[status]}`}>
      <Dot tone={STATUS_TONE[status]} />
      {STOCK_STATUS_INFO[status].label}
    </span>
  );
}

/** A quantity: "—" when it isn't known, red when below zero (oversold). */
export function Qty({ value, strong = false }: { value: number | null | undefined; strong?: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted">—</span>;
  return <span className={`tabular-nums ${value < 0 ? "text-danger" : ""} ${strong ? "font-semibold" : ""}`}>{fmtNum(value)}</span>;
}

export function ProductThumb({ url, title, size = 36 }: { url: string | null; title: string; size?: number }) {
  if (!url) {
    return (
      <span aria-hidden className="grid shrink-0 place-items-center rounded bg-home-soft text-xs font-semibold text-muted" style={{ width: size, height: size }}>
        {title.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  // A plain img: Shopify's CDN sizes it (width=); the static export has no image optimizer.
  return <img src={`${url}${url.includes("?") ? "&" : "?"}width=${size * 2}`} alt="" width={size} height={size} loading="lazy" className="shrink-0 rounded bg-home-soft object-cover" style={{ width: size, height: size }} />;
}

/** A variant's name as shown: the product, and the variant unless it is Shopify's "Default Title". */
export function variantLabel(product: string, variant: string): string {
  return variant && variant !== "Default Title" ? `${product} · ${variant}` : product;
}

export const SOURCE_NOTE: Record<StockSource, string> = {
  levels: "Stock per location, every quantity state, as Shopify reports it.",
  variants: "Shopify's total available per variant only: per-location stock, on hand, committed and incoming need stock-level access.",
};

// ---------------------------------------------------------------------------
// How current the stock is, and Refresh
// ---------------------------------------------------------------------------

/**
 * The header's status pill and Refresh stock, as the design's screens 21–23 put them beside the
 * title: when the stock last matched Shopify (never "live": Shopify gives webhooks no freshness
 * guarantee), whether it may be out of date, and a full read of every location on request.
 */
export function StockStatus() {
  const { base, status, refresh } = useInventory();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!status) return null;
  const s = status.status;
  const levels = s.source === "levels";
  const checked = fmtRelative(s.checkedAt);
  const updated = fmtRelative(s.stockUpdatedAt);
  const failed = s.lastPass?.status === "failed";
  const warn = !s.running && (failed || s.stale);
  const onRefresh = async () => {
    setBusy(true);
    try {
      await api(`${base}/sync`, { method: "POST" });
      toast("info", "Reading every location's stock from Shopify. The figures update when it's done.");
      refresh();
    } catch (e) {
      toast("error", actionError(e, "refresh the stock"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className={`inline-flex min-h-9 max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-text ${warn ? "bg-warn/10" : "bg-accent/10"}`} data-testid="inventory-sync">
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.running ? "animate-pulse bg-accent" : warn ? "bg-warn" : levels ? "bg-good" : "bg-muted"}`} />
        <span className="min-w-0">
          {s.running ? (
            "Checking every stock level against Shopify…"
          ) : levels ? (
            <>
              {failed ? "The last check against Shopify didn't finish" : s.stale ? "Stock may be out of date" : "In step with Shopify"}
              <span className="font-normal text-muted">
                {" "}
                · checked {checked ?? "never"}
                {updated && updated !== checked ? ` · last change ${updated}` : ""} · {fmtNum(s.locations)} {s.locations === 1 ? "location" : "locations"}
              </span>
            </>
          ) : (
            <>
              Shopify&apos;s totals only
              <span className="font-normal text-muted"> · from the catalog import{s.catalogSyncedAt ? `, ${fmtRelative(s.catalogSyncedAt)}` : ""}</span>
            </>
          )}
        </span>
      </p>
      {levels && (
        <button type="button" className="home-btn h-10 border border-home-line bg-surface disabled:opacity-50" onClick={onRefresh} disabled={busy || s.running}>
          <RefreshCw aria-hidden className={`h-4 w-4 ${busy || s.running ? "animate-spin" : ""}`} />
          {s.running ? "Refreshing" : "Refresh stock"}
        </button>
      )}
    </>
  );
}

/** Under the header, when the last scheduled check corrected levels that differed from Shopify. */
export function SyncNote() {
  const { status } = useInventory();
  const s = status?.status;
  if (!s || s.source !== "levels" || !s.lastPass || s.lastPass.trigger !== "reconcile" || s.lastPass.status !== "succeeded" || s.lastPass.differences === 0) return null;
  return (
    <p className="text-xs text-muted" data-testid="sync-differences">
      The last scheduled check found {fmtNum(s.lastPass.differences)} {s.lastPass.differences === 1 ? "level" : "levels"} of {fmtNum(s.lastPass.levelsChecked)} that differed from Shopify, and corrected them.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Connecting stock levels (optional Shopify scopes)
// ---------------------------------------------------------------------------

const AWAITING = "insights:awaiting-scope-grant";

/**
 * What it takes to see stock per location (or to change stock), and the button that asks Shopify
 * for it: only owners and admins can, and only scopes the app declares as optional can be asked
 * for; otherwise it says who or what it waits on.
 */
export function ConnectCard({ capability }: { capability: "stock_levels" | "stock_adjustments" }) {
  const { status } = useInventory();
  const { workspace, store } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const c = status?.capabilities.find((x) => x.id === capability);
  if (!status || !c || c.enabled) return null;
  const requestable = c.missingScopes.length > 0 && c.requestableScopes.length === c.missingScopes.length;
  const what = capability === "stock_levels" ? "see stock at each location, with on-hand, committed and incoming stock" : "change stock in Shopify from here";
  const ask = async () => {
    if (!store) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string | null }>(`/workspaces/${workspace.id}/stores/${store.id}/scopes/request`, { method: "POST", body: { module: capability } });
      if (!r.url) return;
      try {
        window.sessionStorage.setItem(AWAITING, store.id);
      } catch {
        // Blocked storage: the app/scopes_update webhook still unlocks it.
      }
      window.location.assign(r.url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "We couldn't open Shopify. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="home-card animate-rise p-5 sm:p-6" aria-label={c.title} data-testid={`connect-${capability}`}>
      <p className="font-semibold">{c.title}</p>
      <p className="mt-1 text-sm text-muted">
        To {what}, bizinsights needs access to {scopeList(c.missingScopes)} in Shopify.
      </p>
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {!status.can.connect ? (
        <p className="mt-2 text-sm text-muted">An owner or admin of this workspace can turn it on.</p>
      ) : requestable ? (
        <button type="button" className="btn-primary mt-3" onClick={ask} disabled={busy}>
          {busy ? "Opening Shopify…" : "Give access in Shopify"}
        </button>
      ) : c.reconnectableScopes.length ? (
        <p className="mt-2 text-sm">
          <Link href="/settings/stores" className="underline">
            Reconnect the store
          </Link>{" "}
          to grant it.
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">This can&apos;t be turned on for your store yet: the bizinsights app doesn&apos;t offer this access in Shopify yet.{capability === "stock_levels" ? " Until then, Inventory shows Shopify’s total available stock per item." : ""}</p>
      )}
    </section>
  );
}

/** Shown to a member without the permission a page needs. */
export function NoPermission({ what }: { what: string }) {
  return (
    <div className="home-card p-5 sm:p-6" data-testid="inventory-no-permission">
      <p className="font-semibold">You don&apos;t have access to {what}</p>
      <p className="mt-1 text-sm text-muted">Ask an owner or admin of this workspace to give it to you in Team &amp; Access.</p>
    </div>
  );
}

/** A label with its definition one hover or tap away (title for pointers, the text for screen readers). */
export function Defined({ label, definition }: { label: string; definition: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {label}
      <span tabIndex={0} title={definition} aria-label={definition} className="grid h-3.5 w-3.5 cursor-help place-items-center rounded-full border border-muted/60 text-[9px] font-semibold leading-none text-muted">
        ?
      </span>
    </span>
  );
}
