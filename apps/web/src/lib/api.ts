"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCESS_CHANGED_EVENT, signalAccess } from "@/lib/access";

import { ApiError, apiFailure, readApiResponse, UNREACHABLE } from "./apiResponse";
export { ApiError } from "./apiResponse";

/**
 * Only a 401 means the session is gone, and only one for the session the tab uses
 * (ApiError.sessionLeft). Anything else must never sign the user out.
 */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401 && !e.sessionLeft;

/**
 * Dispatched on window whenever any call finds the session gone (the account was deleted or
 * disabled, or signed out elsewhere), so the signed-in shells can send the person to sign in
 * instead of leaving them on a page whose background checks quietly keep the last data up.
 * Only `unauthenticated`: a 401 for a wrong password or a re-authentication is not "signed out".
 */
export const SIGNED_OUT_EVENT = "insights:signed-out";

/** Calls `onSignedOut` whenever a call finds the session gone; returns the unsubscribe (an effect's cleanup). */
export function onSessionGone(onSignedOut: () => void): () => void {
  window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
  return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
}

/**
 * Outage-shaped failures that go away on their own: no response (status 0), a 5xx (the API or its
 * database is unreachable), or a rate limit. Callers retry these instead of showing a dead end.
 */
export const isTransient = (e: unknown) =>
  !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500;

/**
 * Refused because of who is asking (Team & Access): no permission for this, or access to the
 * workspace revoked. What was shown before must not stay on screen.
 */
export const isRefused = (e: unknown) => e instanceof ApiError && e.status === 403 && (e.code === "forbidden" || e.code === "access_revoked" || e.code === "access_expired");

/** Message to show for a failed call: a calm "retrying" line for outages, the API's own text otherwise. */
export function friendlyError(e: unknown): string {
  if (!(e instanceof ApiError) || e.status === 0 || e.status >= 500) return UNREACHABLE;
  return e.message;
}

/**
 * Message for a failed action (a save, a delete). Unlike a load, nothing retries an action on its
 * own, so an outage has to say "try again" rather than friendlyError's "we'll keep trying".
 */
export function actionError(e: unknown, what: string): string {
  if (isTransient(e)) return `We couldn't reach bizinsights to ${what}. Please try again in a moment.`;
  return (e as Error).message;
}

/** Waits between retries of a load that failed: quick at first, then settling at every 30s. */
const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Keep retrying a load that just failed: after 2s, 5s, 15s and then every 30s, and straight away
 * when the browser comes back online or the tab is shown again (the moments an outage has most
 * likely ended, so the backoff starts over there). `attempt` resolves true once nothing is left to
 * retry. Returns the function that stops it, so it can be an effect's cleanup.
 */
export function keepRetrying(attempt: () => Promise<boolean>): () => void {
  let stopped = false;
  let running = false;
  let tries = 0;
  let timer: number | undefined;
  const run = async () => {
    if (stopped || running) return;
    window.clearTimeout(timer);
    running = true;
    const done = await attempt().catch(() => false);
    running = false;
    if (done) stop();
    else if (!stopped) timer = window.setTimeout(run, RETRY_BACKOFF_MS[Math.min(tries++, RETRY_BACKOFF_MS.length - 1)]);
  };
  const wake = () => {
    if (document.visibilityState !== "visible") return;
    tries = 0;
    void run();
  };
  function stop() {
    stopped = true;
    window.clearTimeout(timer);
    window.removeEventListener("online", wake);
    document.removeEventListener("visibilitychange", wake);
  }
  window.addEventListener("online", wake);
  document.addEventListener("visibilitychange", wake);
  timer = window.setTimeout(run, RETRY_BACKOFF_MS[tries++]);
  return stop;
}

/**
 * Whether this tab shows a shared dashboard opened from an invitation link. Kept per tab
 * (sessionStorage): such a tab's calls use the shared-link session only (the API's __share cookie,
 * chosen by the x-bi-context header), while the browser's other tabs stay in the account signed in
 * there, if any. The two sessions never mix.
 */
const CONTEXT_KEY = "bi:context";

export function isSharedTab(): boolean {
  try {
    return sessionStorage.getItem(CONTEXT_KEY) === "shared";
  } catch {
    return false;
  }
}

export function setSharedTab(on: boolean) {
  try {
    if (on) sessionStorage.setItem(CONTEXT_KEY, "shared");
    else sessionStorage.removeItem(CONTEXT_KEY);
  } catch {
    /* storage blocked: the API falls back to the shared session when no account is signed in */
  }
}

/** The tab is closing its shared dashboard (leaveSharedSession): see signedOutHere. */
let leaving = false;

/**
 * Whether a 401 for a call made as `asShared` (isSharedTab() when it was sent) means this tab
 * is signed out. It does only while that is still the tab's session and the tab is not leaving
 * it: closing a shared dashboard signs the shared-link session out while the dashboard's checks
 * are still in flight as it, and those refusals say nothing about the account the tab goes on
 * as (so they must not send it to sign in, or say the link has ended, as it leaves).
 */
export const signedOutHere = (asShared: boolean): boolean => asShared === isSharedTab() && !(asShared && leaving);

/**
 * Close the shared dashboard this tab shows: its shared-link session ends, and the tab is the
 * account's from then on (or nobody's). The sign-out goes first, as the shared-link session,
 * which the tab still is until it has answered: sent as the account's it would end that
 * session instead, and the dashboard's checks meanwhile could re-adopt the link session.
 */
export async function leaveSharedSession(): Promise<void> {
  leaving = true;
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    // Unreachable: the session ends with its link anyway. The tab leaves it either way.
  } finally {
    setSharedTab(false);
    leaving = false;
  }
}

/** The header that says which session a call uses (none for an account's tab). */
export const contextHeaders = (): Record<string, string> => (isSharedTab() ? { "x-bi-context": "shared" } : {});

/** A same-origin API address for a plain link (a download), saying the same as contextHeaders where no header can be sent. */
export const apiHref = (path: string) => `/api${path}${isSharedTab() ? `${path.includes("?") ? "&" : "?"}ctx=shared` : ""}`;

/** All calls go to same-origin /api/* (proxied to the Node API by next.config.ts). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  // As which of the browser's sessions the call is made (contextHeaders): a 401 answers for it.
  const asShared = isSharedTab();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...contextHeaders(), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    // No response at all (offline, DNS, connection reset): status 0, so callers can tell it from a 401.
    throw new ApiError(0, "network", UNREACHABLE);
  }
  // Any change to this member's permissions shows in this header (lib/access.ts).
  const fp = res.headers.get("x-access-fp");
  if (fp) {
    const at = fp.lastIndexOf(":");
    signalAccess({ workspaceId: fp.slice(0, at), fingerprint: fp.slice(at + 1) });
  }
  const json = await readApiResponse(res);
  if (!res.ok) {
    const err = apiFailure(res.status, json);
    if (res.status === 401 && err.code === "unauthenticated") {
      if (signedOutHere(asShared)) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      else err.sessionLeft = true;
    }
    if (isRefused(err)) signalAccess({ refused: err.code as "forbidden" | "access_revoked" | "access_expired" });
    throw err;
  }
  return json as T;
}

export function useApi<T>(path: string | null) {
  // Each answer and failure is kept with the question (path) it answers, and `data` and `error` are
  // only ever this question's. The settings pages stay mounted across a workspace switch, so
  // otherwise the previous workspace's data, or a late answer to it from a retry still in flight,
  // would show under the new one and be saved to it (Notifications sends the whole set per toggle).
  const [answer, setAnswer] = useState<{ path: string; value: T } | null>(null);
  const [failure, setFailure] = useState<{ path: string; error: ApiError } | null>(null);
  const [loading, setLoading] = useState(!!path);
  const data = answer && answer.path === path ? answer.value : null;
  const error = failure && failure.path === path ? failure.error : null;
  // The question being asked now, for the loads and edits that finish after it changed.
  const current = useRef(path);
  /** Resolves true when the load succeeded, there was nothing to load, or the question changed. */
  const load = useCallback(async () => {
    if (!path) return true;
    setLoading(true);
    try {
      const value = await api<T>(path);
      if (current.current !== path) return true;
      setAnswer({ path, value });
      setFailure(null);
      return true;
    } catch (e) {
      if (current.current !== path) return true;
      setFailure({ path, error: e as ApiError });
      // Access taken away: what was shown goes with it.
      if (isRefused(e)) setAnswer(null);
      return false;
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);
  /** For optimistic edits; one made to an earlier question's data (an action that finished late) is dropped. */
  const setData = useCallback(
    (value: T) => {
      if (path && current.current === path) setAnswer({ path, value });
    },
    [path],
  );
  useEffect(() => {
    current.current = path;
    void load();
  }, [path, load]);
  // New permissions: ask again, so what is shown is what they may see now.
  useEffect(() => {
    if (!path) return;
    const again = () => void load();
    window.addEventListener(ACCESS_CHANGED_EVENT, again);
    return () => window.removeEventListener(ACCESS_CHANGED_EVENT, again);
  }, [path, load]);
  // A first load that hit an outage fills in by itself once the outage is over, instead of leaving
  // the page empty until the merchant navigates away and back. Only while nothing has loaded: once
  // there is data the page edits it optimistically (setData), and a late answer must not undo that.
  const retrying = data === null && error !== null && isTransient(error);
  useEffect(() => (retrying ? keepRetrying(load) : undefined), [retrying, load]);
  return { data, error, loading, reload: load, setData };
}

export const fmtMoney = (n: number | null | undefined, currency = "USD") =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
export const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(n);
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat().format(n));

/**
 * Like useApi, but keeps the data live: re-checks `path` every `intervalMs` while the page is
 * visible (and right away when it becomes visible again), and only replaces the data when the
 * response actually changed, so nothing on screen re-renders or jumps for an unchanged answer.
 * A failed background check keeps the last good data on screen.
 *
 * `dataPath` is the question `data` answers: after a change of question it still names the old
 * one until the new answer lands, so the caller can say so when that answer is slow or failing.
 * `failing` is whether the latest check (first or background) failed.
 */
/**
 * Fired after a change that live answers carry (the store's sales calculation, say): every
 * `useLiveApi` asks again at once instead of on its next tick.
 */
export const LIVE_DATA_CHANGED_EVENT = "insights:live-data-changed";
export const liveDataChanged = () => window.dispatchEvent(new Event(LIVE_DATA_CHANGED_EVENT));

export function useLiveApi<T>(path: string | null, intervalMs: number) {
  // The answer and its question are set together, so no render ever pairs one with the other's.
  const [answer, setAnswer] = useState<{ path: string; value: T } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [failing, setFailing] = useState(false);
  const last = useRef<string | null>(null);
  // Bumped whenever the question changes: answers to an older question are ignored.
  const generation = useRef(0);
  const inFlight = useRef(false);

  const check = useCallback(
    async (initial: boolean) => {
      if (!path || (!initial && inFlight.current)) return;
      const gen = generation.current;
      inFlight.current = true;
      if (initial) setLoading(true);
      try {
        const next = await api<T>(path);
        if (gen !== generation.current) return;
        const text = JSON.stringify(next);
        if (text !== last.current) {
          last.current = text;
          setAnswer({ path, value: next });
        }
        setError(null);
        setFailing(false);
        setCheckedAt(Date.now());
      } catch (e) {
        if (gen !== generation.current) return;
        setFailing(true);
        // Refused (permissions changed): the last numbers go, and the refusal shows.
        if (isRefused(e)) {
          last.current = null;
          setAnswer(null);
          setError(e as ApiError);
          return;
        }
        // Only the first load reports errors; later checks keep showing the last good numbers.
        if (initial || last.current === null) setError(e as ApiError);
      } finally {
        if (gen === generation.current) {
          inFlight.current = false;
          if (initial) setLoading(false);
        }
      }
    },
    [path],
  );

  useEffect(() => {
    // New question (other store or dates): the next answer always replaces what's shown, but the
    // old numbers stay up until it arrives instead of flashing an empty page.
    generation.current++;
    last.current = null;
    inFlight.current = false;
    // The previous question's error and last success say nothing about this one. `failing` stays:
    // it is about reaching the server, which asking something else doesn't change.
    setError(null);
    setCheckedAt(null);
    void check(true);
  }, [path, check]);

  // The timer is its own effect so that re-arming it does *not* re-ask the question. Callers
  // change `intervalMs` while the page is open (fast during an import, relaxed once it is done),
  // and folding this into the effect above made every such change flash the loading state.
  useEffect(() => {
    if (!path) return;
    const tick = () => {
      if (document.visibilityState === "visible") void check(false);
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    // Permissions changed: the answer may hold more or less now, so ask at once.
    const now = () => void check(false);
    window.addEventListener(ACCESS_CHANGED_EVENT, now);
    window.addEventListener(LIVE_DATA_CHANGED_EVENT, now);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(ACCESS_CHANGED_EVENT, now);
      window.removeEventListener(LIVE_DATA_CHANGED_EVENT, now);
    };
  }, [path, intervalMs, check]);

  return { data: answer?.value ?? null, dataPath: answer?.path ?? null, error, loading, checkedAt, failing };
}
