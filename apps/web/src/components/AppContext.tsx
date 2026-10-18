"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { allows, type AccessNeed, type MemberAccess } from "@app/shared/access";
import { can, type Role } from "@app/shared/roles";
import type { StaffRole } from "@app/shared/staff";
import { api, contextHeaders, isSharedTab, isSignedOut, isTransient, keepRetrying, onSessionGone, setSharedTab } from "@/lib/api";
import { ACCESS_CHANGED_EVENT, onAccessSignal } from "@/lib/access";
import { offersModule, type AppModule } from "@/lib/features";
import { LoadError, Unreachable } from "@/components/LoadError";
import { AccessRevoked, SharedLinkEnded } from "@/components/team/AccessStates";
import { signInAndReturn } from "@/lib/returnTo";
import { readLocal, storeKey, WORKSPACE_KEY, writeLocal } from "@/lib/storage";

export interface MeWorkspace {
  id: string;
  name: string;
  role: Role;
  staffRole?: StaffRole | null;
  /** What this member may see there (Team & Access): every permission for owners and admins. */
  permissions: string[];
  /**
   * "revoked": an owner or admin took this member's access away; "expired": the access an
   * invitation gave reached its end date and wasn't renewed. Either way the workspace grants nothing.
   */
  status?: "active" | "revoked" | "expired";
  /** When the access an invitation gave ends (null: no end date). */
  accessExpiresAt?: string | null;
  /** Fingerprint of this access (the API's `x-access-fp`): a different one means it changed. */
  fingerprint?: string;
  /**
   * Its stores came in through the App Store app: it offers only what the listing describes
   * (lib/features.ts, APP_STORE_MODULES), and adds stores through that app.
   */
  appStore?: boolean;
}

export interface Me {
  user: { id: string; email: string; emailVerified: boolean; displayName: string | null; timezone: string };
  workspaces: MeWorkspace[];
  /** Organizations this account works for as an employee (the employee portal at /portal). */
  employments?: Array<{ workspaceId: string; organization: string; employeeId: string; fullName: string; jobTitle: string; status: string }>;
  /**
   * Set when this browser opened the app from an invitation link: only that workspace, and none of
   * the account's own pages (profile, sign-in and security) until they sign in to it.
   */
  shared?: { workspaceId: string; readOnly?: boolean; expiresAt?: string } | null;
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
  /** While the store is in error: why its sync stopped (syncProblem in the API). */
  syncProblem?: "shop_unavailable" | "shop_gone" | "shop_locked" | "access" | "not_approved" | "other" | null;
}

/**
 * Whether `stores` is this workspace's real list yet. Until it is "ready" an empty list means "not
 * loaded", not "no stores": "error" is a first load that failed (see `storesError`), and is being
 * retried when that was an outage.
 */
export type StoresStatus = "loading" | "ready" | "error";

interface Ctx {
  me: Me;
  workspace: MeWorkspace;
  /** Workspaces this person can open (revoked ones left out). */
  workspaces: MeWorkspace[];
  setWorkspaceId(id: string): void;
  /** This member's role and permissions in the open workspace (Team & Access). */
  access: MemberAccess;
  /** Whether they may do what `need` names there (the API checks the same on every request). */
  allowed(need: AccessNeed): boolean;
  /** Whether the open workspace offers this part of the app at all (lib/features.ts, offersModule). */
  offers(part: AppModule): boolean;
  /** Set when their access just changed while they were using the app, to say so once. */
  accessNotice: string | null;
  setAccessNotice(text: string | null): void;
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

const isActive = (w: MeWorkspace) => !w.status || w.status === "active";

/**
 * How often the open workspace's permissions are checked while the tab is visible. The check is
 * one tiny request answered 304 while nothing changed; any other response that shows a different
 * fingerprint, or a refusal, checks at once. Enforcement never waits for it: the API checks every
 * request against the database.
 */
const ACCESS_CHECK_MS = 5_000;

interface AccessAnswer {
  role: Role;
  permissions: string[];
  staffRole: StaffRole | null;
  fingerprint: string;
}

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
  const [accessNotice, setAccessNotice] = useState<string | null>(null);
  /** This tab showed a shared dashboard and its shared-link session has gone (closed elsewhere, or ended with the link). */
  const [linkEnded, setLinkEnded] = useState(false);
  /** Signed out: a shared dashboard's tab says its link has ended; an account's goes to sign in. */
  const sessionGone = useCallback(() => {
    if (isSharedTab()) setLinkEnded(true);
    else signInAndReturn(router);
  }, [router]);

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
      sessionGone();
      return true;
    }
    setMeError(null);
    // The API answered with the shared-link session (a tab opened without the link, by someone
    // with no account signed in here): this tab is a shared dashboard's from now on.
    if (m.shared) setSharedTab(true);
    // A shared link was sent to their address, which stands in for verifying it.
    if (!m.user.emailVerified && !m.shared) router.replace("/verify-email");
    // Employees who aren't members of any workspace belong in the employee portal, not onboarding.
    // Someone whose only access was revoked stays: the app says so instead of offering a workspace.
    else if (!m.workspaces.length) router.replace(m.employments?.length ? "/portal" : "/onboarding");
    else {
      setMe(m);
      const active = m.workspaces.filter(isActive);
      if (!currentWs.current || !m.workspaces.some((w) => w.id === currentWs.current)) {
        const saved = readLocal(WORKSPACE_KEY);
        const pick = active.find((w) => w.id === saved) ?? active[0] ?? m.workspaces[0]!;
        currentWs.current = pick.id;
      }
      setWsId(currentWs.current);
    }
    return true;
  }, [router, sessionGone]);

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
  // Any call, not just /me: the dashboard's live checks keep the last numbers up on a failure, so
  // without this a deleted or signed-out account would stay on the page until the next reload.
  useEffect(() => onSessionGone(sessionGone), [sessionGone]);
  const meFailing = meError !== null;
  useEffect(() => (meFailing ? keepRetrying(loadMe) : undefined), [meFailing, loadMe]);

  const current = me?.workspaces.find((w) => w.id === wsId) ?? null;
  const currentActive = !!current && isActive(current);

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
        sessionGone();
        return true;
      }
      setStoresError(e);
      setStoresStatus("error");
      return !isTransient(e);
    }
  }, [wsId, reloadStores, sessionGone]);

  useEffect(() => {
    if (currentActive) void loadStores();
  }, [loadStores, currentActive]);
  const storesRetrying = storesStatus === "error" && isTransient(storesError);
  useEffect(() => (storesRetrying ? keepRetrying(loadStores) : undefined), [storesRetrying, loadStores]);

  // ---- Team & Access: keep this member's permissions current ----
  const fingerprint = useRef<string | undefined>(undefined);
  fingerprint.current = current?.fingerprint;
  const checking = useRef(false);

  /** Replace the open workspace's entry in `me` (permissions changed, or access revoked). */
  const patchWorkspace = useCallback((id: string, patch: Partial<MeWorkspace>) => {
    setMe((m) => (m ? { ...m, workspaces: m.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w)) } : m));
  }, []);

  const checkAccess = useCallback(async () => {
    const ws = currentWs.current;
    if (!ws || checking.current) return;
    checking.current = true;
    try {
      const res = await fetch(`/api/workspaces/${ws}/access`, {
        credentials: "same-origin",
        headers: { ...contextHeaders(), ...(fingerprint.current ? { "if-none-match": `"${fingerprint.current}"` } : {}) },
      });
      if (res.status === 304 || currentWs.current !== ws) return;
      if (res.ok) {
        const a = (await res.json()) as AccessAnswer;
        if (a.fingerprint === fingerprint.current) return;
        const had = fingerprint.current !== undefined;
        patchWorkspace(ws, { role: a.role, permissions: a.permissions, staffRole: a.staffRole, fingerprint: a.fingerprint, status: "active" });
        if (had) {
          setAccessNotice("Your access to this workspace was just updated by an owner or admin. The pages you can open have changed.");
          // After the new permissions are in place, so what asks again asks as the member they are now.
          window.setTimeout(() => window.dispatchEvent(new Event(ACCESS_CHANGED_EVENT)), 0);
        }
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 403 && body.error === "access_revoked") patchWorkspace(ws, { status: "revoked", permissions: [] });
      else if (res.status === 403 && body.error === "access_expired") patchWorkspace(ws, { status: "expired", permissions: [] });
      // Removed from the workspace altogether: /me knows where they can still go.
      else if (res.status === 404) void loadMe();
      else if (res.status === 401) sessionGone();
    } catch {
      // Offline or an outage: the next check tries again; nothing on screen changes meanwhile.
    } finally {
      checking.current = false;
    }
  }, [patchWorkspace, loadMe, sessionGone]);

  // Whenever a response says the access it was answered with differs from the one held, or a
  // request was refused, look again at once.
  useEffect(
    () =>
      onAccessSignal((s) => {
        if (s.refused || (s.workspaceId === currentWs.current && s.fingerprint && s.fingerprint !== fingerprint.current)) void checkAccess();
      }),
    [checkAccess],
  );
  // And every few seconds while the tab is shown, for pages that make no requests of their own.
  useEffect(() => {
    if (!wsId) return;
    const tick = () => {
      if (document.visibilityState === "visible") void checkAccess();
    };
    const timer = window.setInterval(tick, ACCESS_CHECK_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [wsId, checkAccess]);

  const setWorkspaceId = useCallback((id: string) => {
    if (id === currentWs.current) return;
    writeLocal(WORKSPACE_KEY, id);
    currentWs.current = id;
    // The new workspace's stores are unknown until they load, which is not the same as none,
    // and none of the previous workspace's may show under it meanwhile.
    setStores([]);
    setStoresStatus("loading");
    setStoreIdState(null);
    setAccessNotice(null);
    setWsId(id);
  }, []);

  const value = useMemo<Ctx | null>(() => {
    if (!me || !wsId || !current || !isActive(current)) return null;
    const workspace = current;
    const access: MemberAccess = { role: workspace.role, permissions: workspace.permissions ?? [] };
    return {
      me,
      workspace,
      workspaces: me.workspaces.filter(isActive),
      setWorkspaceId,
      access,
      allowed: (need) => allows(access, need),
      offers: (part) => offersModule(workspace.appStore, part),
      accessNotice,
      setAccessNotice,
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
  }, [me, wsId, current, setWorkspaceId, accessNotice, stores, storesStatus, storesError, storeId, loadStores, reloadStores, reloadMe]);

  if (linkEnded) return <SharedLinkEnded />;
  if (me && current && !isActive(current)) {
    const others = me.workspaces.filter(isActive);
    return <AccessRevoked workspace={current.name} others={others} onSwitch={setWorkspaceId} reason={current.status === "expired" ? "expired" : "revoked"} shared={!!me.shared} />;
  }
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
