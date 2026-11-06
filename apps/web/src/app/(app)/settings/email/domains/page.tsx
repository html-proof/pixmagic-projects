"use client";
import { useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { SENDING_SERVICE_INFO, SENDING_SERVICES, type SendingService } from "@app/shared/email";
import { StepNumber } from "@/components/automations/MarketingKit";
import { CheckBadge, CopyValue, DomainStatusBadge, Note, relative } from "@/components/email/EmailUi";
import { LoadError } from "@/components/LoadError";
import { Field } from "@/components/staff/ui";
import { Alert, EmptyState } from "@/components/ui";
import { ConfirmDialog, PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { actionError, api, useApi } from "@/lib/api";
import { fmtDateTime, useEmail, type DomainView } from "@/lib/email";

/**
 * Settings → Email → Domains: prove the business owns a domain, and see how its email
 * authenticates. Each domain is a card as the Stitch design's screen 18 draws a channel: its name,
 * one status word, its three checks; opened, the four records as numbered steps.
 */
export default function EmailDomainsPage() {
  const { base, manage } = useEmail();
  const { data, error, loading, reload, setData } = useApi<{ domains: DomainView[] }>(`${base}/domains`);
  const [domain, setDomain] = useState("");
  const [service, setService] = useState<SendingService>("other");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ domain: DomainView }>(`${base}/domains`, { method: "POST", body: { domain, sendingService: service } });
      setDomain("");
      await reload();
      setOpen(r.domain.id);
    } catch (e2) {
      setErr(actionError(e2, "add the domain"));
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <LoadError what="your domains" error={error} onRetry={reload} busy={loading} />;
  if (!data) return <Skeleton lines={4} />;
  const replace = (d: DomainView) => setData({ domains: data.domains.map((x) => (x.id === d.id ? d : x)) });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sending domains"
        sub="Verify the domains you send from, and check that their SPF, DKIM and DMARC records let mail from them reach inboxes. bizinsights only reads your DNS; it never changes it."
      />
      {manage && (
        <form onSubmit={add} className="home-card animate-rise grid gap-3 p-5 sm:grid-cols-[1fr_16rem_auto] sm:items-end sm:p-6">
          <Field label="Domain" htmlFor="dom-name">
            <input id="dom-name" className="input" required placeholder="yourbusiness.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
          </Field>
          <Field label="Who sends its email" htmlFor="dom-service">
            <select id="dom-service" className="input" value={service} onChange={(e) => setService(e.target.value as SendingService)}>
              {SENDING_SERVICES.map((s) => (
                <option key={s} value={s}>
                  {SENDING_SERVICE_INFO[s].label}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Adding…" : "Add domain"}
          </button>
          {err && <div className="sm:col-span-3"><Alert>{err}</Alert></div>}
        </form>
      )}
      {data.domains.length === 0 ? (
        <EmptyState title="No domains yet" body="Add the domain in your sending address (the part after @) to verify it." />
      ) : (
        data.domains.map((d) => <DomainCard key={d.id} domain={d} manage={manage} expanded={open === d.id} onToggle={() => setOpen(open === d.id ? null : d.id)} onChange={replace} onRemoved={reload} />)
      )}
      <Note>
        Verifying a domain proves your business controls it. Gmail and Microsoft accounts still send only from the address you signed in with; a verified domain lets SMTP addresses at it send without a code, and shows whether its mail will pass authentication.
      </Note>
    </div>
  );
}

function DomainCard({ domain: d, manage, expanded, onToggle, onChange, onRemoved }: { domain: DomainView; manage: boolean; expanded: boolean; onToggle: () => void; onChange: (d: DomainView) => void; onRemoved: () => Promise<boolean> }) {
  const { base } = useEmail();
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState(false);
  const [selectors, setSelectors] = useState(d.dkimSelectors.join(", "));
  const r = d.results;
  const call = (key: string, what: string, path: string, method: string, body?: unknown, msg?: string) =>
    run(key, what, async () => {
      const res = await api<{ domain: DomainView }>(path, { method, body });
      onChange(res.domain);
      return msg;
    });

  return (
    <section aria-labelledby={`dom-${d.id}-h`} className="home-card animate-rise min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3 sm:px-6">
        <h2 id={`dom-${d.id}-h`} className="home-h2 min-w-0 flex-1">
          <button className="flex w-full min-w-0 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onToggle} aria-expanded={expanded}>
            <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
            <span className="min-w-0">
              <span className="block truncate">{d.domain}</span>
              <span className="block text-xs font-normal tracking-normal text-muted">
                {SENDING_SERVICE_INFO[d.sendingService].label} · checked {relative(d.lastCheckedAt)}
              </span>
            </span>
          </button>
        </h2>
        <DomainStatusBadge status={d.status} />
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 pb-5 text-xs sm:px-6" aria-label={`How mail from ${d.domain} authenticates`}>
        <li className="flex items-center gap-1.5">
          <span className="text-muted">SPF</span> <CheckBadge status={d.spf} />
        </li>
        <li className="flex items-center gap-1.5">
          <span className="text-muted">DKIM</span> <CheckBadge status={d.dkim} />
        </li>
        <li className="flex items-center gap-1.5">
          <span className="text-muted">DMARC</span> <CheckBadge status={d.dmarc} />
        </li>
      </ul>
      {expanded && (
        <div className="space-y-4 border-t border-home-line px-5 py-5 sm:px-6">
          {r?.error && <Alert kind="info">{r.error}</Alert>}
          {d.status === "expired" && <Alert>The verification challenge expired. Generate a new record and publish that one instead.</Alert>}
          <Record n={1} title="Ownership" status={r?.ownership?.status ?? null} explanation={r?.ownership?.explanation ?? "Add this TXT record at your DNS provider, then press Check now."}>
            <DnsRow rec={d.records.ownership} />
            {d.status !== "verified" && <p className="text-xs text-muted">The challenge is valid until {fmtDateTime(d.challengeExpiresAt)}.</p>}
          </Record>
          <Record n={2} title="SPF" status={r?.spf?.status ?? null} explanation={r?.spf?.explanation ?? d.records.spf.purpose} found={r?.spf?.records}>
            <DnsRow rec={d.records.spf} hint="If the domain already has an SPF record, add the include to it instead of making a second record." />
          </Record>
          <Record n={3} title="DKIM" status={r?.dkim?.status ?? null} explanation={r?.dkim?.explanation ?? SENDING_SERVICE_INFO[d.sendingService].dkimHelp} found={r?.dkim?.records}>
            {d.records.dkim.length > 0 ? d.records.dkim.map((rec) => <DnsRow key={rec.host} rec={rec} />) : <p className="text-xs text-muted">Enter your provider&apos;s DKIM selector below so bizinsights can check it.</p>}
            {manage && (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void call("sel", "save the selectors", `${base}/domains/${d.id}`, "PATCH", { dkimSelectors: selectors.split(/[\s,]+/).filter(Boolean) }, "Saved. Check now to look them up.");
                }}
              >
                <input aria-label="DKIM selectors" className="input flex-1" placeholder="Selectors, e.g. s1, mail" value={selectors} onChange={(e) => setSelectors(e.target.value)} />
                <button className="btn-secondary" disabled={!!busy}>
                  Save selectors
                </button>
              </form>
            )}
          </Record>
          <Record n={4} title="DMARC" status={r?.dmarc?.status ?? null} explanation={r?.dmarc?.explanation ?? d.records.dmarc.purpose} found={r?.dmarc?.records}>
            <DnsRow rec={d.records.dmarc} />
          </Record>
          {manage && (
            <div className="flex flex-wrap gap-2 border-t border-home-line pt-4">
              {d.status !== "expired" && (
                <button className="btn-primary" disabled={!!busy} onClick={() => call("check", "check DNS", `${base}/domains/${d.id}/verify`, "POST", undefined)}>
                  {busy === "check" ? "Checking…" : "Check now"}
                </button>
              )}
              <select
                aria-label="Who sends this domain's email"
                className="input w-auto"
                value={d.sendingService}
                onChange={(e) => void call("svc", "change the sending service", `${base}/domains/${d.id}`, "PATCH", { sendingService: e.target.value })}
              >
                {SENDING_SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {SENDING_SERVICE_INFO[s].label}
                  </option>
                ))}
              </select>
              {(d.status === "expired" || d.status === "failed") && (
                <button className="btn-secondary" disabled={!!busy} onClick={() => call("regen", "generate a new record", `${base}/domains/${d.id}/regenerate`, "POST", undefined, "New record generated. Publish it in DNS.")}>
                  Generate a new record
                </button>
              )}
              <button className="btn-secondary text-danger" disabled={!!busy} onClick={() => setConfirm(true)}>
                Remove
              </button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={`Remove ${d.domain}?`}
        confirmLabel="Remove"
        danger
        busy={busy === "remove"}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await run("remove", "remove the domain", async () => {
            await api(`${base}/domains/${d.id}`, { method: "DELETE" });
            await onRemoved();
          });
          setConfirm(false);
        }}
      >
        <p>SMTP sender addresses verified through this domain go back to unverified. Your DNS records aren&apos;t touched.</p>
      </ConfirmDialog>
    </section>
  );
}

/** One record to publish, as a numbered step (the design's numbered parts, screen 19). */
function Record({ n, title, status, explanation, found, children }: { n: number; title: string; status: string | null; explanation: string; found?: string[]; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2 rounded border border-home-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <StepNumber n={n} />
          <span>
            <span className="sr-only">{n}. </span>
            {title}
          </span>
        </h3>
        <CheckBadge status={status} />
      </div>
      <p className="text-sm text-muted">{explanation}</p>
      {found && found.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">What bizinsights found</summary>
          <ul className="mt-1 space-y-1">
            {found.map((f) => (
              <li key={f}>
                <code className="break-all">{f}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {children}
    </div>
  );
}

function DnsRow({ rec, hint }: { rec: DomainView["records"]["ownership"]; hint?: string }) {
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-[4rem_1fr_1fr]">
      <span className="font-medium">{rec.type}</span>
      <span className="space-y-1">
        <span className="block text-muted">Host / name</span>
        <CopyValue value={rec.relativeHost} label={`${rec.type} host`} />
        <span className="block text-[11px] text-muted">Full name: {rec.host}</span>
      </span>
      <span className="space-y-1">
        <span className="block text-muted">Value</span>
        <CopyValue value={rec.value} label={`${rec.type} value`} />
      </span>
      {hint && <span className="text-muted sm:col-span-3">{hint}</span>}
    </div>
  );
}
