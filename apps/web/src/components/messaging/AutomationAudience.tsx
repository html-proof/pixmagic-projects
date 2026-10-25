"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { describeSegmentRules, SMS_AUDIENCE_MAX_CUSTOMERS, type SmsAudience, type SmsTrigger } from "@app/shared/sms";
import { Badge } from "@/components/dashboard/Primitives";
import { api, fmtNum, useApi } from "@/lib/api";
import { countryName, plural } from "./MessagingUi";
import type { AudienceCustomer, AudienceEstimate, SmsSegment } from "./types";

// ---------------------------------------------------------------------------
// Step 2's pickers: a saved customer segment, or customers chosen by name, and the API's count of
// who that reaches now (apps/api/src/routes/smsAutomations.ts …/audience). Consent and opt-outs
// are always checked again before each text: these choose who may be considered, nothing more.
// ---------------------------------------------------------------------------

/** About how many customers an audience reaches, as the API counts it (debounced while it's edited). */
export function useAudienceEstimate(base: string | null, trigger: SmsTrigger | null, audience: SmsAudience | null): { estimate: AudienceEstimate | null; loading: boolean } {
  const [estimate, setEstimate] = useState<AudienceEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const key = trigger && audience ? JSON.stringify({ trigger, audience }) : null;
  useEffect(() => {
    if (!base || !key) return setEstimate(null);
    const parsed = JSON.parse(key) as { trigger: SmsTrigger; audience: SmsAudience };
    if (parsed.audience.kind === "trigger") return setEstimate({ customers: null, perEvent: true });
    if ((parsed.audience.kind === "segment" && !parsed.audience.segmentId) || (parsed.audience.kind === "customers" && !parsed.audience.contactIds.length)) return setEstimate(null);
    let stale = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const r = await api<AudienceEstimate>(`${base}/automations/audience`, { method: "POST", body: parsed });
        if (!stale) setEstimate(r);
      } catch {
        if (!stale) setEstimate(null);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [base, key]);
  return { estimate, loading };
}

/** "Recipients: 248 customers" or "1 customer per event", with what the number means. */
export function AudienceCount({ estimate, loading, marketing, daily }: { estimate: AudienceEstimate | null; loading: boolean; marketing: boolean; daily: boolean }) {
  if (loading && !estimate) return <p className="text-sm text-muted">Counting customers…</p>;
  if (!estimate) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-sm" aria-live="polite">
      <span className="font-semibold">
        Recipients: {estimate.customers === null ? "1 customer per event" : plural(estimate.customers, "customer")}
      </span>
      <span className="text-xs text-muted">
        {estimate.customers === null
          ? "Each event texts the one customer it's about."
          : `${daily ? "Who qualifies today" : "Of these, the one an event is about gets it"}${marketing ? ", counting only customers subscribed to your SMS marketing" : ", leaving out anyone who opted out"}.`}
      </span>
    </p>
  );
}

/** The store's saved segments to choose one from (with how many customers each reaches now). */
export function SegmentPicker({ base, value, onChange, disabled, manage, id = "auto-segment" }: { base: string; value: string; onChange: (segmentId: string) => void; disabled: boolean; manage: boolean; id?: string }) {
  const segments = useApi<{ segments: SmsSegment[] }>(`${base}/segments`);
  if (segments.error) return <p className="text-sm text-danger">Couldn&apos;t load your customer segments. Try again in a moment.</p>;
  if (!segments.data) return <div className="skeleton h-10" />;
  const list = segments.data.segments;
  const chosen = list.find((s) => s.id === value);
  if (!list.length)
    return (
      <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted">
        You have no customer segments yet.{" "}
        {manage ? (
          <Link className="font-medium text-accent underline" href="/messaging/segments">
            Create a segment
          </Link>
        ) : (
          "An owner or admin can create one."
        )}{" "}
        (for example customers with 5 or more orders), then come back.
      </p>
    );
  return (
    <div className="space-y-2">
      <label className="label" htmlFor={id}>
        Select customer segment
      </label>
      <select id={id} className="input max-w-md" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose a segment…</option>
        {list.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {value && !chosen && <p className="text-sm text-danger">That segment was deleted: choose another one.</p>}
      {chosen && <p className="text-xs text-muted">Its rules: {describeSegmentRules(chosen.filter)}.</p>}
      {manage && (
        <p className="text-xs">
          <Link className="text-accent underline-offset-2 hover:underline" href="/messaging/segments">
            Create or change segments
          </Link>
        </p>
      )}
    </div>
  );
}

/** Customers chosen by first name or the last digits of their number (masked), up to SMS_AUDIENCE_MAX_CUSTOMERS. */
export function CustomerPicker({ base, value, onChange, disabled, contact }: { base: string; value: string[]; onChange: (ids: string[]) => void; disabled: boolean; contact: boolean }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<AudienceCustomer[] | null>(null);
  const [failed, setFailed] = useState(false);
  const chosen = useApi<{ customers: AudienceCustomer[] }>(contact && value.length ? `${base}/automations/audience/customers?ids=${value.join(",")}` : null);
  const [known, setKnown] = useState<Record<string, AudienceCustomer>>({});
  useEffect(() => {
    if (chosen.data) setKnown((k) => ({ ...k, ...Object.fromEntries(chosen.data!.customers.map((c) => [c.id, c])) }));
  }, [chosen.data]);
  useEffect(() => {
    if (!contact) return;
    let stale = false;
    const t = window.setTimeout(async () => {
      try {
        const r = await api<{ customers: AudienceCustomer[] }>(`${base}/automations/audience/customers?q=${encodeURIComponent(q.trim())}`);
        if (!stale) {
          setFound(r.customers);
          setFailed(false);
        }
      } catch {
        if (!stale) setFailed(true);
      }
    }, 250);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
  }, [base, q, contact]);

  if (!contact) return <p className="text-sm text-muted">Choosing customers by name needs &ldquo;View contact information&rdquo; in Team &amp; Access.</p>;
  const label = (c: AudienceCustomer | undefined, id: string) => (c ? `${c.name ?? "Customer"} · ${c.number}` : id === "" ? "" : "A customer");
  const toggle = (c: AudienceCustomer) => {
    setKnown((k) => ({ ...k, [c.id]: c }));
    onChange(value.includes(c.id) ? value.filter((x) => x !== c.id) : [...value, c.id].slice(0, SMS_AUDIENCE_MAX_CUSTOMERS));
  };
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Chosen customers">
          {value.map((id) => (
            <li key={id} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/5 py-0.5 pl-2.5 pr-1 text-xs">
              {label(known[id], id)}
              <button type="button" className="rounded-full p-0.5 hover:bg-accent/10" disabled={disabled} aria-label={`Remove ${label(known[id], id)}`} onClick={() => onChange(value.filter((x) => x !== id))}>
                <X aria-hidden className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative max-w-md">
        <label className="sr-only" htmlFor="auto-customer-q">
          Find customers
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input id="auto-customer-q" className="input pl-9" type="search" placeholder="First name or last 3 digits" value={q} disabled={disabled} onChange={(e) => setQ(e.target.value)} />
      </div>
      {failed ? (
        <p className="text-sm text-danger">Couldn&apos;t load customers. Try again in a moment.</p>
      ) : !found ? (
        <div className="skeleton h-16" />
      ) : !found.length ? (
        <p className="text-sm text-muted">{q ? "No customer matches." : "No customer with a mobile number has reached bizinsights from this store yet."}</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Customers">
          {found.map((c) => (
            <li key={c.id}>
              <label className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${c.optedOut ? "opacity-60" : ""}`}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={value.includes(c.id)} disabled={disabled || (!value.includes(c.id) && value.length >= SMS_AUDIENCE_MAX_CUSTOMERS)} onChange={() => toggle(c)} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.name ?? "Customer"}</span> <span className="font-mono text-xs text-muted">{c.number}</span>
                  <span className="block text-xs text-muted">
                    {c.country ? `${countryName(c.country)} · ` : ""}
                    {plural(c.orders, "order")}
                  </span>
                </span>
                {c.optedOut ? <Badge tone="neutral">Opted out</Badge> : c.consent === "subscribed" ? <Badge tone="good">Subscribed</Badge> : null}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        {fmtNum(value.length)} of at most {SMS_AUDIENCE_MAX_CUSTOMERS} chosen. Customers who opted out never get a text, even when chosen.
      </p>
    </div>
  );
}
