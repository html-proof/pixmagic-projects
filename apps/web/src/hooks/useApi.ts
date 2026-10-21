"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isTransient } from "@/lib/apiClient";

/** Waits between retries of a load that failed: quick at first, then settling at every 30s. */
const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Keep retrying a load that just failed: after 2s, 5s, 15s and then every 30s, and straight away
 * when the browser comes back online or the tab is shown again (the moments an outage has most
 * likely ended, so the backoff starts over there). `attempt` resolves true once nothing is left to
 * retry. Returns the function that stops it, so it can be an effect's cleanup.
 */
export function keepRetrying(attempt: () => Promise<boolean>, notBefore: () => number = () => 0): () => void {
  let stopped = false;
  let running = false;
  let tries = 0;
  let timer: number | undefined;
  const run = async () => {
    if (stopped || running) return;
    if (notBefore() > Date.now()) { window.clearTimeout(timer); timer = window.setTimeout(run, Math.min(notBefore() - Date.now(), 2_147_483_647)); return; }
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
    window.removeEventListener("insights:retry", wake);
    document.removeEventListener("visibilitychange", wake);
  }
  window.addEventListener("online", wake);
  window.addEventListener("insights:retry", wake);
  document.addEventListener("visibilitychange", wake);
  timer = window.setTimeout(run, Math.min(Math.max(RETRY_BACKOFF_MS[tries++], notBefore() - Date.now()), 2_147_483_647));
  return stop;
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
  const retryAt = useRef(0);
  /** Resolves true when the load succeeded, there was nothing to load, or the question changed. */
  const load = useCallback(async () => {
    if (!path) return true;
    if (retryAt.current > Date.now()) return false;
    setLoading(true);
    try {
      const value = await api<T>(path);
      if (current.current !== path) return true;
      setAnswer({ path, value });
      setFailure(null);
      return true;
    } catch (e) {
      if (current.current !== path) return true;
      retryAt.current = e instanceof ApiError ? e.retryAt ?? 0 : 0;
      setFailure({ path, error: e as ApiError });
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
    retryAt.current = 0;
    void load();
  }, [path, load]);
  // A first load that hit an outage fills in by itself once the outage is over, instead of leaving
  // the page empty until the merchant navigates away and back. Only while nothing has loaded: once
  // there is data the page edits it optimistically (setData), and a late answer must not undo that.
  const retrying = data === null && error !== null && isTransient(error);
  useEffect(() => (retrying ? keepRetrying(load, () => retryAt.current) : undefined), [retrying, load]);
  return { data, error, loading, reload: load, setData };
}

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
  const retryAt = useRef(0);

  const check = useCallback(
    async (initial: boolean) => {
      if (!path || retryAt.current > Date.now() || (!initial && inFlight.current)) return;
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
        retryAt.current = e instanceof ApiError ? e.retryAt ?? 0 : 0;
        setFailing(true);
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
    retryAt.current = 0;
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
    window.addEventListener("online", tick);
    window.addEventListener("insights:retry", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
      window.removeEventListener("insights:retry", tick);
    };
  }, [path, intervalMs, check]);

  return { data: answer?.value ?? null, dataPath: answer?.path ?? null, error, loading, checkedAt, failing, reload: () => check(true) };
}
