"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adConnectionsOf, accountLabel, connectionState, platformState, revokeNote, type AdConnection, type AdProvider, type AdsState, type RevokeOutcome } from "@/lib/adConnections";
import { leavingForSignIn, useBackFromSignIn } from "@/lib/adSignIn";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { AD_PLATFORMS } from "./adPlatforms";
import type { Note } from "./AdUi";

/** How often a card that is synchronizing looks again, until it settles. */
const POLL_MS = 5_000;

/** Why "Connect" didn't open the platform, in words. */
function connectError(e: unknown, name: string): string {
  if (e instanceof ApiError && e.code === "rate_limited") return `You started connecting several times in the last few minutes. Wait a few minutes, then press the ${name} button again.`;
  if (e instanceof ApiError && e.code === "not_configured") return `${name} isn't switched on for bizinsights yet, so there's nothing to connect to. Please try again later.`;
  return actionError(e, `start connecting ${name}`);
}

/**
 * A store's ad connections and everything both integrations pages do with them: connect (or
 * reconnect, or change accounts: the same trip to the platform), refresh, show or hide an account on
 * the dashboard, disconnect one (with what happened to bizinsights' access at the platform), and
 * look again while a sync runs. `base`: /workspaces/:ws/stores/:storeId, null without a store.
 */
export function useAdConnections(base: string | null) {
  const path = base ? `${base}/ads` : null;
  const ads = useApi<AdsState>(path);
  const { setData } = ads;
  const connections = useMemo(() => adConnectionsOf(ads.data), [ads.data]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [leaving, setLeaving] = useState<AdProvider | null>(null);
  const [choosing, setChoosing] = useState<AdProvider | null>(null);
  // Platforms whose last account was just disconnected here: "Disconnected" until the next action.
  const [gone, setGone] = useState<ReadonlySet<AdProvider>>(new Set());
  const [confirming, setConfirming] = useState<AdConnection | null>(null);
  // Back from Facebook's own page without connecting: Facebook never says why to bizinsights, so the page does.
  const [backFromMeta, setBackFromMeta] = useState(false);

  // Another store chosen at the top (the page stays mounted): what was said or under way here was
  // about the last one. Not on the first store's arrival, which a note from the trip back can precede.
  const [storeBase, setStoreBase] = useState(base);
  if (storeBase !== base) {
    setStoreBase(base);
    if (storeBase !== null) {
      setNote(null);
      setGone(new Set());
      setChoosing(null);
      setConfirming(null);
      setBackFromMeta(false);
    }
  }

  useBackFromSignIn((provider) => {
    setLeaving(null);
    setBusy(null);
    if (provider === "meta") setBackFromMeta(true);
  });

  // Looking again (a poll, or after an action): each look is numbered, and only the latest one's
  // answer is shown. A poll sent just before a change can come back after the change's own look, and
  // would put the old state back (useApi keeps answers apart by question, not within one).
  const looks = useRef(0);
  const reload = useCallback(async (): Promise<boolean> => {
    if (!path) return true;
    const n = ++looks.current;
    try {
      const value = await api<AdsState>(path);
      if (n === looks.current) setData(value);
      return true;
    } catch {
      // What is shown stays; a refusal or an ended session is handled by api() itself.
      return false;
    }
  }, [path, setData]);
  const busyNow = useRef(busy);
  busyNow.current = busy;

  const view = (p: AdProvider) =>
    platformState(p, { answer: ads.data, failed: !!ads.error && !ads.data, connections, connecting: leaving === p || choosing === p, justDisconnected: gone.has(p) });

  // A sync is running for an account on the dashboard: look again until it settles, so the badge
  // moves on by itself. Not during an action, which looks again itself when it's done.
  const syncing = connections.some((c) => c.enabled && connectionState(c) === "synchronizing");
  useEffect(() => {
    if (!syncing) return;
    const t = window.setInterval(() => {
      if (!busyNow.current) void reload();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [syncing, reload]);

  const begin = (key: string) => {
    setBusy(key);
    setNote(null);
    setBackFromMeta(false);
  };

  const connect = async (p: AdProvider) => {
    if (!base) return;
    begin(`connect-${p}`);
    setLeaving(p);
    setGone((s) => new Set([...s].filter((x) => x !== p)));
    try {
      const { url } = await api<{ url: string }>(`${base}/ads/${p}/connect`, { method: "POST" });
      leavingForSignIn(p);
      window.location.assign(url);
      // The button stays busy while the browser leaves (useBackFromSignIn resets it if they come back).
    } catch (e) {
      setLeaving(null);
      setBusy(null);
      setNote({ kind: "error", text: connectError(e, AD_PLATFORMS[p].name) });
    }
  };

  const refresh = async (p?: AdProvider) => {
    if (!base) return;
    begin(`sync-${p ?? "all"}`);
    try {
      const { queued } = await api<{ queued: number }>(`${base}/ads/sync`, { method: "POST", body: p ? { provider: p } : {} });
      setNote(
        queued
          ? { kind: "success", text: `Checking ${queued} account${queued === 1 ? "" : "s"} again. It takes a minute or two; the badge says Synchronizing until it's done, and the dashboard follows by itself.` }
          : { kind: "info", text: "Nothing to refresh: no account here is shown on the dashboard and readable. An account that needs reconnecting is refreshed by reconnecting it." },
      );
      await reload();
    } catch (e) {
      setNote({ kind: "error", text: actionError(e, "start a refresh") });
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (c: AdConnection) => {
    if (!base) return;
    begin(`toggle-${c.id}`);
    try {
      await api(`${base}/ads/connections/${c.id}`, { method: "PATCH", body: { enabled: !c.enabled } });
      await reload();
    } catch (e) {
      setNote({ kind: "error", text: actionError(e, c.enabled ? "hide that account" : "show that account") });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    const c = confirming;
    if (!base || !c) return;
    begin(`delete-${c.id}`);
    try {
      const r = await api<{ ok: true; revoked?: RevokeOutcome }>(`${base}/ads/connections/${c.id}`, { method: "DELETE" }).catch((e: unknown) => {
        // Already gone (removed from another tab): the same outcome.
        if (e instanceof ApiError && e.status === 404) return { ok: true as const, revoked: undefined };
        throw e;
      });
      const after = revokeNote(c.provider, r.revoked);
      const text = `${accountLabel(c)} is disconnected: its access and the figures fetched for it are deleted from bizinsights.`;
      // The note takes the focus: the row whose Disconnect button had it goes with the reload.
      setNote(
        after?.kind === "info"
          ? { kind: "info", text: `${text} ${after.text}`, link: after.link, focus: true }
          : { kind: "success", text: after ? `${text} ${after.text}` : text, focus: true },
      );
      if (!connections.some((x) => x.provider === c.provider && x.id !== c.id)) setGone((s) => new Set([...s, c.provider]));
    } catch (e) {
      setNote({ kind: "error", text: actionError(e, "disconnect that account") });
    } finally {
      setConfirming(null);
      setBusy(null);
      // Show what's really left, even when the removal failed part-way.
      await reload();
    }
  };

  const cancelDisconnect = useCallback(() => setConfirming(null), []);

  return {
    /** GET .../ads, once answered. */
    answer: ads.data,
    loadError: ads.error,
    loading: ads.loading,
    /** Look again after a change (only the latest look's answer is shown). */
    reload,
    /** Try the first load again after it failed (its error clears when it works). */
    retry: ads.reload,
    connections,
    view,
    busy,
    note,
    setNote,
    leaving,
    setChoosing,
    backFromMeta,
    setBackFromMeta,
    connect,
    refresh,
    toggle,
    confirming,
    askDisconnect: setConfirming,
    disconnect,
    cancelDisconnect,
  };
}
