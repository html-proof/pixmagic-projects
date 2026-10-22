"use client";
import { useRef, useState } from "react";
import { History } from "lucide-react";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { useApi } from "@/lib/api";
import { authErrorMessage, signInActivity, type SignInEvent } from "@/lib/auth";
import { CardHeader, dayTime, Pill, Place } from "./ui";

/** Rows shown until "View all". */
const FIRST = 5;
const PAGE = 20;

const failedAt = (e: SignInEvent) => (e.step === "code" ? "Wrong code" : "Wrong password");

/** Success, or Failed with where it stopped (in its tooltip, and for screen readers). */
function Status({ event: e }: { event: SignInEvent }) {
  if (e.status === "success") return <Pill t="good">Success</Pill>;
  return (
    <span title={failedAt(e)}>
      <Pill t="danger">Failed</Pill>
      <span className="sr-only"> ({failedAt(e)})</span>
    </span>
  );
}

/**
 * The account's sign-ins, newest first: those that got in, and those stopped at the password or the
 * code (an address with no account records nothing). "View all" shows the rest, a page at a time.
 */
export function ActivityCard({ expanded, onExpanded }: { expanded: boolean; onExpanded: (v: boolean) => void }) {
  const q = useApi<{ events: SignInEvent[]; nextCursor: string | null }>(`/auth/account/activity?limit=${PAGE}`);
  // Pages loaded after the first, with the cursor that follows them; kept with the first page they continue.
  const [more, setMore] = useState<{ after: string; events: SignInEvent[]; next: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  const first = q.data;
  const continues = more && first && more.after === first.nextCursor ? more : null;
  const events = [...(first?.events ?? []), ...(continues?.events ?? [])];
  const next = continues ? continues.next : (first?.nextCursor ?? null);
  const shown = expanded ? events : events.slice(0, FIRST);

  async function loadMore() {
    if (!first || !next) return;
    const ask = ++asked.current;
    setLoading(true);
    setError(null);
    try {
      const page = await signInActivity(next, PAGE);
      if (ask !== asked.current) return;
      setMore({ after: first.nextCursor!, events: [...(continues?.events ?? []), ...page.events], next: page.nextCursor });
    } catch (err) {
      if (ask === asked.current) setError(authErrorMessage(err));
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  }

  return (
    <section id="sign-in-activity" aria-labelledby="activity-h" className="card scroll-mt-24 overflow-hidden p-0">
      <div className="p-5">
        <CardHeader
          id="activity-h"
          t="info"
          icon={History}
          title="Recent sign-in activity"
          sub="A log of your recent sign-in attempts."
          action={
            events.length > FIRST || next ? (
              <button type="button" className="btn-secondary min-h-10 px-4" aria-expanded={expanded} onClick={() => onExpanded(!expanded)}>
                {expanded ? "Show less" : "View all"}
              </button>
            ) : undefined
          }
        />
      </div>
      {q.error && !first ? (
        <div className="px-5 pb-5">
          <LoadError what="your sign-in activity" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
        </div>
      ) : !first ? (
        <div className="space-y-3 px-5 pb-5" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-8" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="border-t border-border px-5 py-6 text-sm text-muted">No sign-ins recorded yet. Each new sign-in, and each one stopped at the password or the code, will show here.</p>
      ) : (
        <div className="@container">
          <table className="hidden w-full text-left text-sm @xl:table">
            <thead className="border-y border-border bg-bg/60 text-xs text-muted">
              <tr>
                <th scope="col" className="py-2.5 pr-3 pl-5 font-semibold">Time</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Device</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">IP Address</th>
                <th scope="col" className="px-3 py-2.5 font-semibold">Location</th>
                <th scope="col" className="py-2.5 pr-5 pl-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-b-0">
                  <td className="py-2.5 pr-3 pl-5 whitespace-nowrap">{dayTime(e.at)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap" title={[e.device.browser, e.device.os].filter(Boolean).join(" · ") || undefined}>
                    {e.device.name}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[13px] tabular-nums">{e.ip ?? <span className="font-sans text-muted">Unknown</span>}</td>
                  <td className="max-w-52 px-3 py-2.5">
                    <Place place={e.location} compact />
                  </td>
                  <td className="py-2.5 pr-5 pl-3">
                    <Status event={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y divide-border border-t border-border @xl:hidden">
            {shown.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">{e.device.name}</p>
                  <p className="text-muted">{dayTime(e.at)}</p>
                  <div className="text-muted">
                    <Place place={e.location} compact />
                  </div>
                  {e.ip && <p className="font-mono text-[13px] text-muted">{e.ip}</p>}
                </div>
                <Status event={e} />
              </li>
            ))}
          </ul>
          {expanded && (next || error) && (
            <div className="space-y-3 border-t border-border px-5 py-3 text-center">
              {error && <Alert kind="error">{error}</Alert>}
              {next && (
                <button type="button" className="btn-secondary" disabled={loading} onClick={() => void loadMore()}>
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
