"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { ZAPIER_CANNOT, ZAPIER_EVENT_INFO, ZAPIER_SEARCHES } from "@app/shared/zapier";
import { api, ApiError, friendlyError, isTransient, keepRetrying } from "@/lib/api";
import { setReturnTo } from "@/lib/returnTo";
import { Alert } from "@/components/ui";
import { BrandLogo } from "@/components/Brand";

/** The consent request as GET /api/oauth/zapier/authorize answers it. */
type Consent = {
  client: { name: string };
  account: { email: string };
  workspaces: Array<{ id: string; name: string; allowed: boolean; stores: Array<{ id: string; name: string; shopDomain: string }> }>;
  cancelUrl: string;
};
type Who = { user: { email: string } | null };

/**
 * Zapier's "Connect bizinsights" opens this page (bizinsights is the OAuth provider of its Zapier app,
 * docs/zapier.md). The signed-in member chooses the workspace and store Zapier may reach, sees what it
 * will be able to do and what it won't, and allows it or cancels. The request itself (client, the exact
 * redirect URI, response_type, state) is checked by the API: a wrong one is never redirected to, and
 * the state goes back to Zapier exactly as it came. Signed out, the visitor signs in and comes back
 * here (returnTo keeps the whole address, query included).
 */
function ConnectZapier() {
  const router = useRouter();
  const params = useSearchParams();
  const query = useMemo(() => {
    const q = new URLSearchParams();
    for (const k of ["client_id", "redirect_uri", "response_type", "state"]) q.set(k, params.get(k) ?? "");
    return q.toString();
  }, [params]);
  const [consent, setConsent] = useState<Consent | null>(null);
  /** Why the page can't go on (a request that isn't Zapier's, Zapier not set up, a shared link). */
  const [refusal, setRefusal] = useState<{ code: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const who = await api<Who>("/auth/whoami");
      if (!who.user) {
        setReturnTo(`/connect/zapier?${query}`);
        router.replace("/login");
        return true;
      }
      const c = await api<Consent>(`/oauth/zapier/authorize?${query}`);
      setConsent(c);
      const first = c.workspaces.find((w) => w.allowed && w.stores.length);
      if (first) {
        setWorkspaceId((ws) => ws || first.id);
        setStoreId((s) => s || first.stores[0]!.id);
      }
      setLoadError(null);
      return true;
    } catch (e) {
      // Signed out since (the session ended): sign in and come back.
      if (e instanceof ApiError && e.status === 401) {
        setReturnTo(`/connect/zapier?${query}`);
        router.replace("/login");
        return true;
      }
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        setRefusal({ code: e.code, message: e.message });
        return true;
      }
      if (e instanceof ApiError && e.code === "not_configured") {
        setRefusal({ code: e.code, message: e.message });
        return true;
      }
      setLoadError(e);
      return !isTransient(e);
    }
  }, [query, router]);

  useEffect(() => void load(), [load]);
  const failing = loadError !== null;
  useEffect(() => (failing ? keepRetrying(load) : undefined), [failing, load]);

  const workspace = consent?.workspaces.find((w) => w.id === workspaceId) ?? null;
  const allowedWorkspaces = consent?.workspaces.filter((w) => w.allowed && w.stores.length) ?? [];
  const others = consent?.workspaces.filter((w) => !w.allowed) ?? [];

  async function allow() {
    if (!workspace || !storeId) return;
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(new URLSearchParams(query));
      const r = await api<{ redirect: string }>(`/workspaces/${encodeURIComponent(workspace.id)}/stores/${encodeURIComponent(storeId)}/zapier/authorize`, { method: "POST", body });
      // Back to Zapier, with the code and the state it sent.
      window.location.assign(r.redirect);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : friendlyError(e));
      setBusy(false);
    }
  }

  function cancel() {
    if (consent) window.location.assign(consent.cancelUrl);
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <p>
        <BrandLogo size={24} className="text-[15px] text-text" />
      </p>
      <div className="card mt-6 space-y-4" data-testid="zapier-consent">
        {error && <Alert>{error}</Alert>}
        {!consent && !refusal && !failing && <p className="text-sm text-muted">Loading…</p>}
        {failing && !consent && (
          <>
            <Alert kind="info">{friendlyError(loadError)}</Alert>
            <button type="button" className="btn-secondary" onClick={() => void load()}>
              Try again
            </button>
          </>
        )}

        {refusal && (
          <>
            <h1 className="text-xl font-semibold">{refusal.code === "shared_link" ? "Sign in to your own account" : refusal.code === "not_configured" ? "Zapier isn't available yet" : "This request can't be completed"}</h1>
            <p className="text-sm text-muted">{refusal.message}</p>
            {refusal.code === "shared_link" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setReturnTo(`/connect/zapier?${query}`);
                  router.push("/login");
                }}
              >
                Sign in
              </button>
            )}
          </>
        )}

        {consent && (
          <>
            <h1 className="text-xl font-semibold">Allow Zapier to use bizinsights?</h1>
            <p className="text-sm text-muted">
              Signed in as <strong>{consent.account.email}</strong>. Zapier will reach one store, for Zaps in your own Zapier account. You can disconnect it at any time in Settings, then Integrations.
            </p>

            {allowedWorkspaces.length === 0 ? (
              <Alert kind="info">
                {consent.workspaces.length
                  ? 'Connecting Zapier needs the "Manage integrations" permission in a workspace with a connected store. Ask an owner or admin of your workspace.'
                  : "Your account has no workspace with a connected store yet."}
              </Alert>
            ) : (
              <div className="space-y-3">
                <label className="block text-sm">
                  <span className="font-medium">Workspace</span>
                  <select
                    className="input mt-1 w-full"
                    value={workspaceId}
                    onChange={(e) => {
                      const w = allowedWorkspaces.find((x) => x.id === e.target.value);
                      setWorkspaceId(e.target.value);
                      setStoreId(w?.stores[0]?.id ?? "");
                    }}
                  >
                    {allowedWorkspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="font-medium">Store</span>
                  <select className="input mt-1 w-full" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
                    {(workspace?.stores ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.shopDomain})
                      </option>
                    ))}
                  </select>
                </label>
                {others.length > 0 && <p className="text-xs text-muted">Not listed: {others.map((w) => w.name).join(", ")}, where you don&apos;t have &quot;Manage integrations&quot;.</p>}
              </div>
            )}

            <section aria-labelledby="zapier-can" className="space-y-2 text-sm">
              <h2 id="zapier-can" className="font-medium">
                Zapier will be able to
              </h2>
              <ul className="space-y-1.5">
                {Object.values(ZAPIER_EVENT_INFO).map((e) => (
                  <li key={e.label} className="flex items-start gap-2">
                    <Check size={16} className="mt-0.5 shrink-0 text-good" aria-hidden />
                    <span>
                      <span className="font-medium">Get &quot;{e.label}&quot;</span>
                      <span className="text-muted">: {e.description}</span>
                    </span>
                  </li>
                ))}
                {ZAPIER_SEARCHES.map((s) => (
                  <li key={s.key} className="flex items-start gap-2">
                    <Check size={16} className="mt-0.5 shrink-0 text-good" aria-hidden />
                    <span>
                      <span className="font-medium">{s.label}</span>
                      <span className="text-muted">: {s.description}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted">Each one only within what your own permissions let you see in bizinsights, and only while you keep them.</p>
            </section>

            <section aria-labelledby="zapier-cannot" className="space-y-2 text-sm">
              <h2 id="zapier-cannot" className="font-medium">
                Zapier won&apos;t be able to
              </h2>
              <ul className="space-y-1.5">
                {ZAPIER_CANNOT.map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <X size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden />
                    <span className="text-muted">{t}</span>
                  </li>
                ))}
              </ul>
            </section>

            <div className="flex flex-wrap gap-2 pt-2">
              <button type="button" className="btn-primary" disabled={busy || !workspace || !storeId} onClick={() => void allow()} data-testid="zapier-allow">
                {busy ? "Connecting…" : "Allow"}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={cancel}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function ConnectZapierPage() {
  return (
    <Suspense>
      <ConnectZapier />
    </Suspense>
  );
}
