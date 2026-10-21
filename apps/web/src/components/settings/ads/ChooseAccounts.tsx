"use client";
import { useEffect, useId, useMemo, useState } from "react";
import { adAccountStatusLabel } from "@app/shared/ads";
import { Alert } from "@/components/ui";
import { AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import type { AdProvider, PendingAccounts } from "@/lib/adConnections";
import { actionError, api, useApi } from "@/lib/api";

type Account = PendingAccounts["accounts"][number];

/** More accounts than this (an agency or manager login): a search box, and nothing ticked to start with. */
const MANY = 20;

/** Accounts the platform says can't run: left unticked unless they were chosen before. */
const NOT_RUNNING = new Set(["closed", "closing", "disabled"]);

/** What to tick when the list opens. */
function firstChoice(accounts: Account[]): Set<string> {
  // Reconnecting keeps what was chosen before: the accounts shown on the dashboard, not the hidden ones.
  if (accounts.some((a) => a.connected)) return new Set(accounts.filter((a) => a.connected && a.enabled !== false).map((a) => a.accountId));
  // A first connection starts with every account that runs ticked, unless there are so many that
  // ticking each wanted one is easier.
  if (accounts.length > MANY) return new Set();
  return new Set(accounts.filter((a) => !a.status || !NOT_RUNNING.has(a.status)).map((a) => a.accountId));
}

/**
 * After a sign-in that sees several accounts: tick the ones that belong to this store. `onLoaded`
 * says which platform the list is for (its card says Connecting meanwhile); `onDone` closes it, with
 * an error to show when it couldn't load.
 */
export function ChooseAccounts({
  pick,
  base,
  storeId,
  storeName,
  onLoaded,
  onDone,
}: {
  pick: string;
  /** /workspaces/:ws/stores/:storeId */
  base: string;
  storeId: string;
  storeName: string;
  onLoaded: (provider: AdProvider) => void;
  onDone: (error?: string) => void;
}) {
  const path = `${base}/ads/pending/${encodeURIComponent(pick)}`;
  const { data, error } = useApi<PendingAccounts>(path);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const findId = useId();

  useEffect(() => {
    if (!data || chosen) return;
    setChosen(firstChoice(data.accounts));
    onLoaded(data.provider);
  }, [data, chosen, onLoaded]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || !q) return data?.accounts ?? [];
    return data.accounts.filter((a) => a.accountId.toLowerCase().includes(q) || (a.name ?? "").toLowerCase().includes(q));
  }, [data, query]);

  if (error) {
    return (
      <Alert>
        {actionError(error, "load the accounts to choose from")}{" "}
        <button type="button" className="underline" onClick={() => onDone()}>
          Close
        </button>
      </Alert>
    );
  }
  if (!data || !chosen) return <div className="card skeleton h-40" aria-busy="true" aria-label="Loading the accounts to choose from" />;
  const P = AD_PLATFORMS[data.provider];
  const many = data.accounts.length > MANY;
  const filtered = shown.length !== data.accounts.length;

  const toggle = (id: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setShown = (on: boolean) =>
    setChosen((s) => {
      const next = new Set(s);
      for (const a of shown) {
        if (on) next.add(a.accountId);
        else next.delete(a.accountId);
      }
      return next;
    });

  const confirm = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await api<{ provider: AdProvider; connected: number }>(path, { method: "POST", body: { accountIds: [...chosen] } });
      // The numbers live on the dashboard: go and watch them arrive.
      window.location.assign(`/dashboard?${new URLSearchParams({ adsConnected: r.provider, accounts: String(r.connected), store: storeId })}`);
    } catch (e) {
      setFailed(actionError(e, "connect those accounts"));
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    await api(path, { method: "DELETE" }).catch(() => undefined);
    onDone();
  };

  return (
    <section className="card border-accent/40" aria-labelledby="choose-h" data-testid="ads-choose">
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-white">
          <P.Icon size={22} />
        </span>
        <div>
          <h2 id="choose-h" className="font-semibold">
            Choose {P.name} accounts for {storeName}
          </h2>
          <p className="text-xs text-muted">
            Your login can see {data.accounts.length} account{data.accounts.length === 1 ? "" : "s"}. Tick the ones whose numbers belong on this store&apos;s dashboard; an
            account you untick is hidden from it. You can change this later.
          </p>
        </div>
      </div>
      {data.truncated && (
        <div className="mt-3">
          <Alert kind="info">
            {P.name} has more accounts for this login than bizinsights could list at once, so some aren&apos;t here. If one is missing, connect again with a login that
            reaches fewer accounts, or ask for access to that account directly.
          </Alert>
        </div>
      )}
      {failed && (
        <div className="mt-3">
          <Alert>{failed}</Alert>
        </div>
      )}
      {many && (
        <div className="mt-4 max-w-sm">
          <label className="label" htmlFor={findId}>
            Find an account
          </label>
          <input id={findId} className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or account ID" autoComplete="off" />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        {data.accounts.length > 3 && (
          <>
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setShown(true)} disabled={busy || !shown.length}>
              {filtered ? "Select all shown" : "Select all"}
            </button>
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setShown(false)} disabled={busy || !shown.length}>
              {filtered ? "Select none shown" : "Select none"}
            </button>
          </>
        )}
        <span className="text-muted" aria-live="polite" data-testid="ads-choose-count">
          {chosen.size} selected{filtered ? ` · ${shown.length} of ${data.accounts.length} shown` : ""}
        </span>
      </div>
      <fieldset className="mt-3">
        <legend className="sr-only">Accounts to connect</legend>
        {shown.length ? (
          <ul className="max-h-[28rem] divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {shown.map((a) => {
              const status = adAccountStatusLabel(a.status, data.provider);
              return (
                <li key={a.accountId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-3">
                    <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={chosen.has(a.accountId)} onChange={() => toggle(a.accountId)} disabled={busy} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {a.name ?? "Unnamed account"}
                        {status && (
                          <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted" title={a.statusDetail ?? undefined}>
                            {status}
                          </span>
                        )}
                      </span>
                      <span className="block text-xs text-muted">
                        {a.accountId}
                        {a.currency ? ` · ${a.currency}` : ""}
                        {a.timezone ? ` · ${a.timezone}` : ""}
                        {a.connected ? (a.enabled === false ? " · connected, hidden from the dashboard" : " · already connected") : ""}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-sm text-muted">No account matches &ldquo;{query}&rdquo;.</p>
        )}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" onClick={() => void confirm()} disabled={busy || chosen.size === 0} data-testid="ads-choose-confirm">
          {busy ? "Connecting…" : `Connect ${chosen.size} account${chosen.size === 1 ? "" : "s"}`}
        </button>
        <button type="button" className="btn-secondary" onClick={() => void cancel()} disabled={busy}>
          Cancel
        </button>
        {chosen.size === 0 && <span className="text-xs text-muted">Tick at least one account.</span>}
      </div>
    </section>
  );
}
