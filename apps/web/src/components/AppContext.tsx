"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { can, type Role } from "@app/shared/roles";
import type { StaffRole } from "@app/shared/staff";
import { api, isSignedOut, isTransient, keepRetrying } from "@/lib/api";
import { LoadError, Unreachable } from "@/components/LoadError";
import { signInAndReturn } from "@/lib/returnTo";
import { readLocal, storeKey, WORKSPACE_KEY, writeLocal } from "@/lib/storage";

export interface Me {
  user: { id: string; email: string; emailVerified: boolean; displayName: string | null; timezone: string };
  workspaces: Array<{ id: string; name: string; role: Role; staffRole?: StaffRole | null }>;
  /** Organizations this account works for as an employee (the employee portal at /portal). */
  employments?: Array<{ workspaceId: string; organization: string; employeeId: string; fullName: string; jobTitle: string; status: string }>;
}
export interface StoreSummary {
  id: string;
  shopDomain: string;
  name: string | null;
  timezone: string;
  currency: string;
  status: string;
  grantedScopes: string[];
  /** Of those, the ones the app declared optional and can hand back (Settings - Stores). */
  revocableScopes: string[];
  pixelInstalled: boolean;
  lastSyncedAt: string | null;
  /** How much of the store actually landed, so the UI can tell an empty store from a broken one. */
  imported?: { orders: number; products: number };
}

/**
 * Whether `stores` is this workspace's real list yet. Until it is "ready" an empty list means "not
 * loaded", not "no stores": "error" is a first load that failed (see `storesError`), and is being
 * retried when that was an outage.
 */
export type StoresStatus = "loading" | "ready" | "error";

interface Ctx {
  me: Me;
  workspace: Me["workspaces"][number];
  setWorkspaceId(id: string): void;
  stores: StoreSummary[];
  storesStatus: StoresStatus;
  /** Why the first stores load failed, while storesStatus is "error". */
  storesError: unknown;
  /** Asks for the stores again, reporting a failure through storesStatus rather than rejecting. */
  retryStores(): void;
  store: StoreSummary | null;
  setStoreId(id: string): void;
  reloadStores(): Promise<void>;
  /** Resolves false when /me couldn't be reached: `me` is then the one from before (and is retried). */
  reloadMe(): Promise<boolean>;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  /** Why /me last failed, while it is failing for any reason other than being signed out. */
  const [meError, setMeError] = useState<unknown>(null);
  const [wsId, setWsId] = useState<string | null>(null);
  // `wsId` as of right now (state lags a render), so a /stores answer that lands after a workspace
  // switch can tell it belongs to the workspace no longer shown.
  const currentWs = useRef<string | null>(null);
  const [stores, setStores] = useState<StoreSummary[]>([]);
  const [storesStatus, setStoresStatus] = useState<StoresStatus>("loading");
  const [storesError, setStoresError] = useState<unknown>(null);
  const [storeId, setStoreIdState] = useState<string | null>(null);

  /**
   * One look at /me. Only a 401 means the session is gone. Anything else (the API or its database
   * unreachable, a dropped connection, a rate limit) keeps the merchant where they are with what is
   * already on screen, and is retried below. Resolves true once there is nothing left to retry.
   */
  const loadMe = useCallback(async () => {
    let m: Me;
    try {
      m = await api<Me>("/me");
    } catch (e) {
      if (!isSignedOut(e)) {
        setMeError(e);
        return false;
      }
      signInAndReturn(router);
      return true;
    }
    setMeError(null);
    if (!m.user.emailVerified) router.replace("/verify-email");
    // Employees who aren't members of any workspace belong in the employee portal, not onboarding.
    else if (!m.workspaces.length) router.replace(m.employments?.length ? "/portal" : "/onboarding");
    else {
      setMe(m);
      if (!currentWs.current) {
        const saved = readLocal(WORKSPACE_KEY);
        currentWs.current = m.workspaces.some((w) => w.id === saved) ? saved : m.workspaces[0]!.id;
      }
      setWsId(currentWs.current);
    }
    return true;
  }, [router]);

  // Settings pages await this after a save: it makes one attempt and never waits out the retries,
  // so a failed /me keeps the current `me` (and the save's "Saved.") while the retry below catches up.
  const reloadMe = useCallback(() => loadMe(), [loadMe]);

  /** Rejects when the load fails, so the actions that call it can report that. */
  const reloadStores = useCallback(async () => {
    if (!wsId) return;
    const { stores } = await api<{ stores: StoreSummary[] }>(`/workspaces/${wsId}/stores`);
    if (currentWs.current !== wsId) return;
    setStores(stores);
    setStoresStatus("ready");
    const saved = readLocal(storeKey(wsId));
    setStoreIdState((cur) => (stores.some((s) => s.id === cur) ? cur : stores.some((s) => s.id === saved) ? saved : (stores[0]?.id ?? null)));
  }, [wsId]);

  useEffect(() => void loadMe(), [loadMe]);
  const meFailing = meError !== null;
  useEffect(() => (meFailing ? keepRetrying(loadMe) : undefined), [meFailing, loadMe]);

  /**
   * Each workspace's first stores load, and its retries. A failure is not "no stores": the views
   * built on the list say what happened instead (see StoresPending). Only a 401 means signed out,
   * and only an outage is worth retrying; anything else (no longer a member of this workspace) will
   * not change by asking again. Resolves true once nothing is left to retry.
   */
  const loadStores = useCallback(async () => {
    try {
      await reloadStores();
      return true;
    } catch (e) {
      if (currentWs.current !== wsId) return true;
      if (isSignedOut(e)) {
        signInAndReturn(router);
        return true;
      }
      setStoresError(e);
      setStoresStatus("error");
      return !isTransient(e);
    }
  }, [wsId, reloadStores, router]);

  useEffect(() => void loadStores(), [loadStores]);
  const storesRetrying = storesStatus === "error" && isTransient(storesError);
  useEffect(() => (storesRetrying ? keepRetrying(loadStores) : undefined), [storesRetrying, loadStores]);

  const value = useMemo<Ctx | null>(() => {
    if (!me || !wsId) return null;
    const workspace = me.workspaces.find((w) => w.id === wsId) ?? me.workspaces[0]!;
    return {
      me,
      workspace,
      setWorkspaceId: (id) => {
        if (id === currentWs.current) return;
        writeLocal(WORKSPACE_KEY, id);
        currentWs.current = id;
        // The new workspace's stores are unknown until they load, which is not the same as none,
        // and none of the previous workspace's may show under it meanwhile.
        setStores([]);
        setStoresStatus("loading");
        setStoreIdState(null);
        setWsId(id);
      },
      stores,
      storesStatus,
      storesError,
      retryStores: () => void loadStores(),
      store: stores.find((s) => s.id === storeId) ?? null,
      setStoreId: (id) => {
        writeLocal(storeKey(workspace.id), id);
        setStoreIdState(id);
      },
      reloadStores,
      reloadMe,
    };
  }, [me, wsId, stores, storesStatus, storesError, storeId, loadStores, reloadStores, reloadMe]);

  if (!value) return meFailing ? <Unreachable error={meError} onRetry={() => void loadMe()} /> : <p className="p-8 text-muted">Loading…</p>;
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const v = useContext(AppCtx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/**
 * What a view built on the store list shows until this workspace's list has loaded, or null once it
 * has. Without it, "not loaded yet" and "couldn't load" both read as "no stores", which tells a
 * connected merchant to connect their store again.
 */
export function StoresPending() {
  const { storesStatus, storesError, retryStores } = useApp();
  if (storesStatus === "ready") return null;
  if (storesStatus === "loading") return <p className="text-muted">Loading your stores…</p>;
  return <LoadError what="your stores" error={storesError} onRetry={retryStores} />;
}

/** Whether this role may connect and manage stores (the shared permission matrix decides). */
export const canManage = (role: Role) => can(role, "stores:manage");
