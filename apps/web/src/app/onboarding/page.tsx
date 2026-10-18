"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, fmtNum, friendlyError, isSignedOut, keepRetrying, type ApiError } from "@/lib/api";
import { Alert } from "@/components/ui";
import { BrandLogo } from "@/components/Brand";
import type { Me } from "@/components/AppContext";
import { ShopifyIcon } from "@/components/ShopifyIcon";
import { signInAndReturn } from "@/lib/returnTo";
import { readLocal, storeKey, WORKSPACE_KEY, writeLocal } from "@/lib/storage";
import { OAUTH_ERRORS } from "@/lib/shopifyErrors";

type SyncJob = { kind: string; status: string; progress: number; error: string | null };
type SyncState = { store: { status: string; name: string | null; shopDomain: string }; jobs: SyncJob[] };


const STEP_LABELS = ["Verify email", "Connect Shopify", "First sync"];
const JOB_LABELS: Record<string, string> = {
  shop: "Store details",
  orders: "Orders",
  products: "Products",
  variants: "Inventory & variants",
  install_pixel: "Storefront funnel tracking",
};
const JOB_ORDER = Object.keys(JOB_LABELS);

/** Newest job per kind (the API lists newest first), in the order the import runs. */
function firstSyncJobs(jobs: SyncJob[]): SyncJob[] {
  const latest = new Map<string, SyncJob>();
  for (const j of jobs) if (!latest.has(j.kind)) latest.set(j.kind, j);
  const rank = (k: string) => (JOB_ORDER.includes(k) ? JOB_ORDER.indexOf(k) : JOB_ORDER.length);
  return [...latest.values()].sort((a, b) => rank(a.kind) - rank(b.kind));
}

/** Every import step has finished (successfully or for good). */
function settled(jobs: SyncJob[]): boolean {
  const latest = firstSyncJobs(jobs);
  return latest.length > 0 && latest.every((j) => j.status === "succeeded" || j.status === "failed");
}

function jobStatus(j: SyncJob): string {
  if (j.status === "succeeded") return j.progress ? `Done · ${fmtNum(j.progress)}` : "Done";
  if (j.status === "failed") return "Failed – we'll retry";
  if (j.status === "running") return j.progress ? `Importing… ${fmtNum(j.progress)}` : "Working…";
  return "Waiting";
}


/** Used when the store isn't known yet (one-click connect); renamable in Settings. */
const DEFAULT_WORKSPACE_NAME = "My store";

/** "demo-shop" / "demo-shop.myshopify.com" → "Demo Shop"; anything else → the default name. */
function workspaceNameFor(shop: string | null | undefined): string {
  const handle = (shop ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split(/[/?#]/)[0]!
    .replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(handle)) return DEFAULT_WORKSPACE_NAME;
  return handle
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function Onboarding() {
  const router = useRouter();
  const params = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [shop, setShop] = useState((params.get("shop") ?? "").replace(/\.myshopify\.com$/i, ""));
  const [error, setError] = useState<string | null>(params.get("error") ? (OAUTH_ERRORS[params.get("error")!] ?? "Connection failed.") : null);
  /** Which connect button is waiting on the API / Shopify redirect. */
  const [busy, setBusy] = useState<null | "oneclick" | "manual">(null);
  const [manual, setManual] = useState(!!params.get("shop"));
  const [sync, setSync] = useState<SyncState | null>(null);
  /** Workspace that owns `?store=` (the user may belong to several). */
  const [syncWsId, setSyncWsId] = useState<string | null>(null);
  const storeId = params.get("store");
  /** Why /me last failed, while it fails for any reason other than being signed out. */
  const [meError, setMeError] = useState<unknown>(null);

  /**
   * One look at /me. Only a 401 means signed out: sending a merchant to /login because our API or
   * database is unreachable loses the store they were connecting, and they're still signed in. So
   * wait it out here, re-asking in the background. Resolves true once there is nothing to retry.
   */
  const loadMe = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
      setMeError(null);
    } catch (e) {
      if (!isSignedOut(e)) {
        setMeError(e);
        return false;
      }
      // Come back here after signing in: Shopify sends merchants who aren't signed in to this page
      // with ?shop=, and the connection carries on from it.
      signInAndReturn(router);
    }
    return true;
  }, [router]);

  useEffect(() => void loadMe(), [loadMe]);
  const meFailing = meError !== null;
  useEffect(() => (meFailing ? keepRetrying(loadMe) : undefined), [meFailing, loadMe]);

  // Connect into the workspace the user came from: `?ws=`, else the one the app shell has selected.
  // Always taking the first one attached a store connected from a second workspace to the wrong
  // workspace, and made Reconnect fail with "store taken" for a store living in another one.
  const wantedWs = params.get("ws");
  const ws = me
    ? (me.workspaces.find((w) => w.id === wantedWs) ?? me.workspaces.find((w) => w.id === readLocal(WORKSPACE_KEY)) ?? me.workspaces[0])
    : undefined;
  const step = !me || !me.user.emailVerified ? 0 : ws && storeId ? 2 : 1;

  // Find the store's workspace, and make it (and the store) the dashboard's selection.
  useEffect(() => {
    if (step !== 2 || !me || !storeId || syncWsId) return;
    void Promise.all(
      me.workspaces.map((w) =>
        me.workspaces.length === 1
          ? w.id
          : api<{ stores: Array<{ id: string }> }>(`/workspaces/${w.id}/stores`)
              .then((r) => (r.stores.some((st) => st.id === storeId) ? w.id : null))
              .catch(() => null),
      ),
    ).then((ids) => {
      const id = ids.find(Boolean) ?? me.workspaces[0]!.id;
      // What the app shell opens on (storage blocked: it falls back to the first workspace/store).
      writeLocal(WORKSPACE_KEY, id);
      writeLocal(storeKey(id), storeId);
      setSyncWsId(id);
    });
  }, [step, me, storeId, syncWsId]);

  useEffect(() => {
    if (step !== 2 || !syncWsId || !storeId) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<SyncState>(`/workspaces/${syncWsId}/stores/${storeId}/sync`);
        if (!stop) setSync(s);
        // Orders finishing makes the store active; products and inventory may still be importing.
        if (s.store.status !== "syncing" && settled(s.jobs)) return;
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [step, syncWsId, storeId]);

  /** The workspace to connect into; first-time users get one created on their first click. */
  async function ensureWorkspace(name: string): Promise<string> {
    if (ws) return ws.id;
    const { workspace } = await api<{ workspace: Me["workspaces"][number] }>("/workspaces", {
      method: "POST",
      body: { name },
    });
    // Keep the page in step with the server so a retry reuses this workspace instead of creating another.
    setMe((m) => (m ? { ...m, workspaces: [workspace, ...m.workspaces] } : m));
    return workspace.id;
  }

  /** Start a connect flow on the API and follow the Shopify URL it returns. */
  async function goTo(kind: "oneclick" | "manual", path: (wsId: string) => string, body: unknown, name: string) {
    setBusy(kind);
    setError(null);
    try {
      const wsId = await ensureWorkspace(name);
      const { url } = await api<{ url: string }>(path(wsId), { method: "POST", body });
      window.location.assign(url);
    } catch (err) {
      const e = err as ApiError;
      // shop_required: the store picker on Shopify can't reach this merchant's app, so the
      // address form is the way through. Open it rather than leaving a dead end.
      if (e.code === "shop_required") setManual(true);
      setError(OAUTH_ERRORS[e.code] ?? e.message);
      setBusy(null);
    }
  }

  /** One click: Shopify handles sign-in, store picking and approval, then sends the user back. */
  function connectWithShopify() {
    void goTo("oneclick", (id) => `/workspaces/${id}/shopify/start`, {}, DEFAULT_WORKSPACE_NAME);
  }

  function connect(e: FormEvent) {
    e.preventDefault();
    void goTo("manual", (id) => `/workspaces/${id}/shopify/install`, { shop }, workspaceNameFor(shop));
  }

  // Arrived from Shopify (app launched from the admin) with the store already known: finish without typing.
  const launchShop = params.get("shop");
  const autoStarted = useRef(false);
  useEffect(() => {
    if (step !== 1 || !me || !launchShop || params.get("error") || autoStarted.current) return;
    autoStarted.current = true;
    void goTo("manual", (id) => `/workspaces/${id}/shopify/install`, { shop: launchShop }, workspaceNameFor(launchShop));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, me, launchShop]);

  // Coming back with the browser's Back button from Shopify restores the page as it was: re-enable it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const jobs = firstSyncJobs(sync?.jobs ?? []);
  const doneJobs = jobs.filter((j) => j.status === "succeeded").length;
  const ready = sync?.store.status === "active" && settled(sync.jobs);

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <p>
        <BrandLogo size={24} className="text-[15px] text-text" />
      </p>
      <h1 className="mt-2 text-2xl font-semibold">{step === 2 ? "Importing your store" : "Let’s get your store set up"}</h1>
      <ol className="mt-6 flex flex-wrap gap-2 text-xs" aria-label="Progress">
        {STEP_LABELS.map((l, i) => (
          <li key={l} aria-current={i === step ? "step" : undefined} className={`rounded-full border px-3 py-1 ${i < step ? "border-good text-good" : i === step ? "border-accent font-semibold" : "border-border text-muted"}`}>
            {i < step ? "✓ " : `${i + 1}. `}
            {l}
          </li>
        ))}
      </ol>

      <div className="card mt-6 space-y-4">
        {error && <Alert>{error}</Alert>}
        {!me && !meFailing && <p className="text-sm text-muted">Loading…</p>}
        {!me && meFailing && (
          <>
            <Alert kind="info">{friendlyError(meError)}</Alert>
            <button type="button" className="btn-secondary" onClick={() => void loadMe()}>Try again</button>
          </>
        )}
        {me && step === 0 && (
          <>
            <p>Please verify your email address first. It protects the store data you&apos;re about to connect.</p>
            <button className="btn-primary" onClick={() => router.push("/verify-email")}>Verify email</button>
          </>
        )}
        {me && step === 1 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              You&apos;ll sign in to Shopify, pick your store and approve read-only access. We only ask for what the dashboard uses, and you can disconnect any time.
            </p>
            <button type="button" className="btn-primary w-full sm:w-auto" disabled={!!busy} onClick={connectWithShopify}>
              <ShopifyIcon onAccent />
              {busy === "oneclick" ? "Opening Shopify…" : "Continue with Shopify"}
            </button>
            {/* Shopify's own store picker is the way in (App Store requirement 2.3.1: never ask
                a merchant to type their store's address). The address form appears only when the
                API says the picker can't reach this merchant's app (shop_required), or prefilled
                when Shopify itself named the store (?shop=). */}
            {manual && (
              <form onSubmit={connect} className="space-y-3 border-t border-border pt-4">
                <label className="label" htmlFor="shop">Your store address</label>
                <div className="flex items-center gap-2">
                  <input
                    id="shop"
                    className="input"
                    required
                    placeholder="your-store"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={shop}
                    onChange={(e) => setShop(e.target.value)}
                  />
                  <span className="shrink-0 text-sm text-muted">.myshopify.com</span>
                </div>
                <button className="btn-secondary" disabled={!!busy}>{busy === "manual" ? "Opening Shopify…" : "Connect this store"}</button>
              </form>
            )}
          </div>
        )}
        {me && step === 2 && (
          <div className="space-y-4">
            <div>
              {sync && <p className="font-medium">{sync.store.name ?? sync.store.shopDomain}</p>}
              <p className="text-sm text-muted">
                {ready
                  ? "All set. Your numbers are ready."
                  : sync?.store.status === "error"
                    ? "We hit a problem importing your store. Open your dashboard: bizinsights retries the import from there, and shows whatever has arrived so far."
                    : "We're importing your orders, products and inventory. This usually takes a minute or two, and it's fine to leave this page."}
              </p>
            </div>
            {jobs.length > 0 && (
              <div
                className="h-2 overflow-hidden rounded-full bg-bg"
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={jobs.length}
                aria-valuenow={ready ? jobs.length : doneJobs}
              >
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${ready ? 100 : Math.round((doneJobs / jobs.length) * 100)}%` }} />
              </div>
            )}
            <ul className="space-y-2 text-sm">
              {jobs.map((j) => (
                <li key={j.kind} className="flex items-center justify-between gap-3">
                  <span>{JOB_LABELS[j.kind] ?? j.kind}</span>
                  <span className={j.status === "failed" ? "text-danger" : j.status === "succeeded" ? "text-good" : "text-muted"}>{jobStatus(j)}</span>
                </li>
              ))}
              {!sync && <li className="text-muted">Checking progress…</li>}
            </ul>
            <button className={ready ? "btn-primary" : "btn-secondary"} onClick={() => router.push("/dashboard")}>
              {ready ? "Go to dashboard" : "Skip to dashboard"}
            </button>
          </div>
        )}
      </div>
      {/* The errors above tell merchants to contact support; this page has no AuthShell, so link it here. */}
      <p className="mt-6 text-center text-xs text-muted">
        <Link prefetch={false} className="underline" href="/support">Support</Link>
        {" · "}
        <Link prefetch={false} className="underline" href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}

export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}
