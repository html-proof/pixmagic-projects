"use client";
import { useEffect, useId, useState } from "react";
import { accountLabel, type AdConnection } from "@/lib/adConnections";
import { actionError, api } from "@/lib/api";

/** The API's limit on chosen sites (PATCH .../ads/connections/:id). */
const MAX_SITES = 200;

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Which of an AdSense account's sites count for this store (ad_connections.sites, empty = every
 * site, including ones added later). The choices are the sites AdSense reported for the account
 * (availableSites); saving asks for the earnings again, split by those sites.
 */
export function AdsenseSites({ c, base, manage, onSaved }: { c: AdConnection; base: string; manage: boolean; onSaved: () => Promise<unknown> }) {
  const id = useId();
  const [every, setEvery] = useState(c.sites.length === 0);
  const [chosen, setChosen] = useState<string[]>(c.sites);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "done"; text: string } | null>(null);
  // Saved elsewhere (another tab, a reload): start again from what is stored.
  const stored = c.sites.join("\n");
  useEffect(() => {
    setEvery(stored === "");
    setChosen(stored ? stored.split("\n") : []);
  }, [stored]);

  const options = [...new Set([...c.availableSites, ...c.sites])].sort();
  const summary = c.sites.length ? c.sites.join(", ") : "Every site";

  if (!manage || !options.length) {
    return (
      <p className="text-xs text-muted" data-testid="adsense-sites">
        Sites counted for this store: {summary}.
        {!options.length && " The sites appear here once AdSense has reported earnings for them."}
      </p>
    );
  }

  const next = every ? [] : chosen;
  const changed = !sameSet(next, c.sites);
  const save = async () => {
    if (!every && !chosen.length) return setMsg({ kind: "error", text: "Tick at least one site, or choose every site." });
    if (next.length > MAX_SITES) return setMsg({ kind: "error", text: `Choose up to ${MAX_SITES} sites, or every site.` });
    setBusy(true);
    setMsg(null);
    try {
      await api(`${base}/ads/connections/${c.id}`, { method: "PATCH", body: { sites: next } });
      await onSaved();
      setMsg({ kind: "done", text: "Saved. The earnings are fetched again for these sites; the dashboard follows in a minute or two." });
    } catch (e) {
      setMsg({ kind: "error", text: actionError(e, "save the sites") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-lg border border-border px-3 py-2 text-sm" data-testid="adsense-sites">
      <summary className="cursor-pointer select-none">
        Sites counted for this store: <strong>{summary}</strong>
        <span className="sr-only"> ({accountLabel(c)})</span>
      </summary>
      <fieldset className="mt-3 space-y-2">
        <legend className="text-xs text-muted">The sites of {accountLabel(c)} whose earnings count for this store</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-mode`} checked={every} onChange={() => setEvery(true)} disabled={busy} />
          Every site, including sites added later
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-mode`} checked={!every} onChange={() => setEvery(false)} disabled={busy} />
          Only the sites ticked below
        </label>
        <ul className="ml-6 max-h-56 space-y-1 overflow-y-auto">
          {options.map((site) => (
            <li key={site}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={every || chosen.includes(site)}
                  disabled={busy || every}
                  onChange={() => setChosen((s) => (s.includes(site) ? s.filter((x) => x !== site) : [...s, site]))}
                />
                <span className="break-all">{site}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="mt-2 text-xs text-muted">
        AdSense splits earnings by site only for sites it reports separately. Earnings it doesn&apos;t split by site can only count when every site is chosen.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary h-9" onClick={() => void save()} disabled={busy || !changed} data-testid="adsense-sites-save">
          {busy ? "Saving…" : "Save sites"}
        </button>
        {msg && (
          <span role={msg.kind === "error" ? "alert" : "status"} className={`text-xs ${msg.kind === "error" ? "text-danger" : "text-muted"}`}>
            {msg.text}
          </span>
        )}
      </div>
    </details>
  );
}
