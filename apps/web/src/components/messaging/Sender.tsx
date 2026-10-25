"use client";
import { useEffect, useState } from "react";
import {
  COUNTRY_RULES,
  SENDER_TYPE_LABEL,
  SENDER_TYPES,
  skipLabel,
  SMS_TRANSACTIONAL_BASES,
  smsSenderSchema,
  type SenderType,
  type SmsTransactionalBasis,
} from "@app/shared/sms";
import { ConfirmDialog, PageHeader, Skeleton, useToast } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, fmtNum, useApi } from "@/lib/api";
import { countryName, CountryPicker, fmtHour, fmtUsd, fmtWhen, ModeBanner, smsError, useSms, useSmsAction } from "./MessagingUi";
import { TestNumbers } from "./TestNumbers";
import type { PublicSender, SenderResponse } from "./types";

const CHECK: Record<string, { tone: Tone; label: string; help: string }> = {
  unchecked: { tone: "neutral", label: "Not checked yet", help: "Check it with AWS before sending can be turned on." },
  verified: { tone: "good", label: "Verified with AWS", help: "AWS knows this identity and it is set up for your workspace." },
  not_found: { tone: "danger", label: "Not found in AWS", help: "AWS has no such identity in this region. Check the ARN or id, or ask bizinsights support." },
  not_allowed: { tone: "danger", label: "Not set up for your workspace", help: "The identity exists but isn't tagged for your workspace, so it can't send for you." },
  error: { tone: "warn", label: "Couldn't check", help: "AWS didn't answer. Try again in a few minutes." },
};

const REGISTRATION: Record<string, string> = {
  complete: "Registered",
  in_review: "Registration in review",
  required: "Registration needed",
  not_required: "No registration needed",
  unknown: "Not known yet",
};

const BASIS: Record<SmsTransactionalBasis, { label: string; help: string }> = {
  none: { label: "None chosen", help: "No order updates are sent by text. Marketing texts still need each customer's SMS marketing consent." },
  checkout_notice: {
    label: "My checkout tells customers",
    help: "Your checkout tells customers who leave a mobile number that order updates come by text. You confirm this is true; bizinsights records who chose it and when.",
  },
  sms_consent: { label: "Only customers subscribed to SMS", help: "Order updates only go to customers subscribed to your SMS marketing in Shopify." },
};

interface Draft {
  senderType: SenderType;
  originationIdentity: string;
  countries: string[];
  monthlyBudgetUsd: string;
  hardStop: boolean;
  monthlyMessageQuota: string;
  transactionalBasis: SmsTransactionalBasis;
  quietStart: number;
  quietEnd: number;
  maxPerCustomerDay: string;
  maxMarketingPerWeek: string;
  dltEntityId: string;
}

/** Nothing is switched on by default: no budget (nothing is sent with 0), no basis for order updates. */
const blank = (): Draft => ({
  senderType: "sender_id",
  originationIdentity: "",
  countries: [],
  monthlyBudgetUsd: "0",
  hardStop: true,
  monthlyMessageQuota: "",
  transactionalBasis: "none",
  quietStart: 21,
  quietEnd: 9,
  maxPerCustomerDay: "3",
  maxMarketingPerWeek: "2",
  dltEntityId: "",
});

const fromSender = (s: PublicSender): Draft => ({
  senderType: s.senderType as SenderType,
  originationIdentity: s.originationIdentity ?? "",
  countries: s.countries,
  monthlyBudgetUsd: String(s.monthlyBudgetUsd),
  hardStop: s.hardStop,
  monthlyMessageQuota: s.monthlyMessageQuota ? String(s.monthlyMessageQuota) : "",
  transactionalBasis: s.transactionalBasis as SmsTransactionalBasis,
  quietStart: s.quietStart,
  quietEnd: s.quietEnd,
  maxPerCustomerDay: String(s.maxPerCustomerDay),
  maxMarketingPerWeek: String(s.maxMarketingPerWeek),
  dltEntityId: s.dltEntityId ?? "",
});

const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));

function parse(d: Draft) {
  const r = smsSenderSchema.safeParse({
    senderType: d.senderType,
    originationIdentity: d.originationIdentity,
    countries: d.countries,
    monthlyBudgetUsd: num(d.monthlyBudgetUsd),
    hardStop: d.hardStop,
    monthlyMessageQuota: d.monthlyMessageQuota.trim() ? Number(d.monthlyMessageQuota) : null,
    transactionalBasis: d.transactionalBasis,
    quietStart: d.quietStart,
    quietEnd: d.quietEnd,
    maxPerCustomerDay: num(d.maxPerCustomerDay),
    maxMarketingPerWeek: num(d.maxMarketingPerWeek),
    dltEntityId: d.countries.includes("IN") && d.dltEntityId.trim() ? d.dltEntityId.trim() : null,
  });
  if (r.success) return { ok: true as const, input: r.data };
  const LABEL: Record<string, string> = {
    senderType: "Sender type",
    originationIdentity: "Origination identity",
    countries: "Countries",
    monthlyBudgetUsd: "Monthly budget",
    monthlyMessageQuota: "Monthly text limit",
    maxPerCustomerDay: "Texts per customer a day",
    maxMarketingPerWeek: "Marketing texts per customer a week",
    dltEntityId: "DLT Entity ID",
  };
  return {
    ok: false as const,
    problems: r.error.issues.map((i) => `${LABEL[String(i.path[0])] ?? String(i.path[0])}: ${i.code === "invalid_type" && i.expected === "number" ? "enter a number" : i.message}`),
  };
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function SenderForm({ data, onSaved }: { data: SenderResponse; onSaved: () => Promise<unknown> }) {
  const { base, manage, store } = useSms();
  const toast = useToast();
  const s = data.sender;
  const [d, setD] = useState<Draft>(() => (s ? fromSender(s) : blank()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (data.sender) setD(fromSender(data.sender));
  }, [data.sender]);
  const saved = s ? fromSender(s) : null;
  const dirty = !saved || JSON.stringify(saved) !== JSON.stringify(d);
  const parsed = parse(d);
  const identityChanged = !!s && manage && s.originationIdentity !== d.originationIdentity.trim();
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = async () => {
    setTried(true);
    if (!parsed.ok) return;
    setBusy(true);
    setError(null);
    try {
      await api(`${base}/sender`, { method: "PUT", body: parsed.input });
      await onSaved();
      toast("success", s ? "Saved." : "Saved. Now check it with AWS.");
    } catch (e) {
      setError(smsError(e, "save the sender"));
    } finally {
      setBusy(false);
    }
  };
  const editable = manage;
  return (
    <section className="card animate-rise" aria-labelledby="snd-form-h">
      <h2 id="snd-form-h" className="font-semibold">
        Sender settings
      </h2>
      {!manage && <p className="mt-1 text-sm text-muted">Only owners and admins can change these.</p>}
      {error && (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <fieldset disabled={!editable} className="mt-4 min-w-0 space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="snd-type">
              Sender type
            </label>
            <select id="snd-type" className="input" value={d.senderType} onChange={(e) => set({ senderType: e.target.value as SenderType })}>
              {SENDER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SENDER_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="snd-identity">
              Origination identity (ARN or id)
            </label>
            {manage ? (
              <input
                id="snd-identity"
                className="input font-mono text-[13px]"
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
                value={d.originationIdentity}
                onChange={(e) => set({ originationIdentity: e.target.value.trim() })}
                placeholder="arn:aws:sms-voice:ap-southeast-2:…:sender-id/…"
              />
            ) : (
              <input id="snd-identity" className="input" value={s?.identityLabel ?? "Hidden"} readOnly />
            )}
            <p className="mt-1 text-xs text-muted">Registered by bizinsights in AWS and tagged for your workspace. Ask bizinsights support for yours; an identity tagged for another workspace can&apos;t be used.</p>
            {identityChanged && s?.sendingEnabled && <p className="mt-1 text-xs text-warn">Changing it turns sending off until the new identity is checked with AWS.</p>}
          </div>
        </div>

        <CountryPicker
          label="Countries this sender texts"
          value={d.countries}
          onChange={(countries) => set({ countries })}
          help="India needs a sender of its own (AWS sends Indian traffic from Mumbai); it can't share one with other countries."
        />
        {d.countries.length > 0 && (
          <ul className="space-y-1 text-xs text-muted">
            {d.countries.map((c) => (
              <li key={c}>
                <strong className="text-text">{countryName(c)}:</strong> {COUNTRY_RULES[c]?.registration ?? "Check AWS's requirements for this country before sending there."}
              </li>
            ))}
          </ul>
        )}
        {d.countries.includes("IN") && (
          <div className="max-w-sm">
            <label className="label" htmlFor="snd-dlt">
              DLT Principal Entity ID (India)
            </label>
            <input id="snd-dlt" className="input font-mono" inputMode="numeric" maxLength={30} value={d.dltEntityId} onChange={(e) => set({ dltEntityId: e.target.value.replace(/\D/g, "") })} />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="snd-budget">
              Monthly budget (US$)
            </label>
            <input id="snd-budget" className="input" type="number" min={0} max={100000} step="0.01" value={d.monthlyBudgetUsd} onChange={(e) => set({ monthlyBudgetUsd: e.target.value })} />
            <p className="mt-1 text-xs text-muted">Nothing is sent while it is 0. You&apos;re told at 50%, 80% and 100%.</p>
          </div>
          <div>
            <label className="label" htmlFor="snd-quota">
              Monthly text limit (optional)
            </label>
            <input id="snd-quota" className="input" type="number" min={1} value={d.monthlyMessageQuota} onChange={(e) => set({ monthlyMessageQuota: e.target.value })} placeholder="No limit" />
          </div>
          <label className="flex items-start gap-2 text-sm sm:mt-7">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={d.hardStop} onChange={(e) => set({ hardStop: e.target.checked })} />
            <span>
              Stop sending when the budget is used up
              <span className="block text-xs text-muted">Recommended. Off: texts continue and you&apos;re still told.</span>
            </span>
          </label>
        </div>

        <fieldset className="min-w-0">
          <legend className="label">How customers agree to order updates by text</legend>
          <div className="space-y-2">
            {SMS_TRANSACTIONAL_BASES.map((b) => (
              <label key={b} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${d.transactionalBasis === b ? "border-accent bg-accent/5" : "border-border"}`}>
                <input type="radio" name="snd-basis" className="mt-0.5 accent-[var(--accent)]" checked={d.transactionalBasis === b} onChange={() => set({ transactionalBasis: b })} />
                <span>
                  <span className="font-medium">{BASIS[b].label}</span>
                  <span className="block text-xs text-muted">{BASIS[b].help}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">A phone number on an order, or a past purchase, is never taken as agreement. Customers who opt out of every text get nothing, whatever you choose.</p>
          {s?.transactionalBasisAt && <p className="mt-1 text-xs text-muted">Last changed {fmtWhen(s.transactionalBasisAt, store?.timezone)}.</p>}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="label">Quiet hours</p>
            <div className="flex items-center gap-2 text-sm">
              <label className="sr-only" htmlFor="snd-qs">
                Quiet from
              </label>
              <select id="snd-qs" className="input" value={d.quietStart} onChange={(e) => set({ quietStart: Number(e.target.value) })}>
                {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
              to
              <label className="sr-only" htmlFor="snd-qe">
                Quiet until
              </label>
              <select id="snd-qe" className="input" value={d.quietEnd} onChange={(e) => set({ quietEnd: Number(e.target.value) })}>
                {HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}
              </select>
            </div>
            <p className="mt-1 text-xs text-muted">In the customer&apos;s time where their country has one time zone, else the store&apos;s. For campaigns and Send SMS; workflows have their own.</p>
          </div>
          <div>
            <label className="label" htmlFor="snd-day">
              Texts per customer a day
            </label>
            <input id="snd-day" className="input" type="number" min={1} max={20} value={d.maxPerCustomerDay} onChange={(e) => set({ maxPerCustomerDay: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="snd-week">
              Marketing texts per customer a week
            </label>
            <input id="snd-week" className="input" type="number" min={0} max={14} value={d.maxMarketingPerWeek} onChange={(e) => set({ maxMarketingPerWeek: e.target.value })} />
          </div>
        </div>
      </fieldset>
      {tried && !parsed.ok && (
        <div className="mt-3">
          <Alert>
            <ul className="list-disc space-y-0.5 pl-4">
              {parsed.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </Alert>
        </div>
      )}
      {manage && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          {dirty && saved && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setD(saved)}>
              Discard changes
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** Sender Configuration: the AWS identity texts come from, where to, within what budget, and the switches. */
export function SenderConfiguration() {
  const { base, manage, store } = useSms();
  const tz = store?.timezone;
  const { data, error, reload, loading } = useApi<SenderResponse>(base ? `${base}/sender` : null);
  const { busy, run } = useSmsAction();
  const [switching, setSwitching] = useState<{ kind: "sending" | "marketing"; on: boolean } | null>(null);
  if (error) return <LoadError what="the sender" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!data) return <Skeleton lines={6} />;
  const s = data.sender;
  const check = CHECK[s?.identityCheck ?? "unchecked"] ?? CHECK.unchecked!;
  const verified = s?.identityCheck === "verified";
  const held = s?.heldUntil && new Date(s.heldUntil).getTime() > Date.now();
  const verify = () =>
    run("verify", "check the sender with AWS", async () => {
      const r = await api<{ sender: PublicSender }>(`${base}/sender/verify`, { method: "POST", body: {} });
      await reload();
      return r.sender.identityCheck === "verified" ? "Verified with AWS." : `AWS check: ${CHECK[r.sender.identityCheck]?.label ?? r.sender.identityCheck}.`;
    });
  const toggle = (kind: "sending" | "marketing", on: boolean) =>
    run(kind, on ? "turn it on" : "turn it off", async () => {
      await api(`${base}/sender/sending`, { method: "POST", body: { [kind]: on } });
      setSwitching(null);
      await reload();
      return kind === "sending" ? (on ? "Sending is on." : "Sending is off. Texts that were waiting were cancelled.") : on ? "Marketing texts are on." : "Marketing texts are off.";
    });

  return (
    <div className="space-y-4">
      <PageHeader title="SMS Sender" sub="Which AWS number or sender ID your texts come from, the countries it reaches, your budget and limits, and the switches that let texts go out." />
      <ModeBanner mode={data.mode} showLive />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card animate-rise" aria-labelledby="snd-aws-h">
          <h2 id="snd-aws-h" className="font-semibold">
            AWS account
          </h2>
          {data.mode === "off" ? (
            <p className="mt-2 text-sm text-muted">Not checked while SMS isn&apos;t switched on for bizinsights.</p>
          ) : data.accountError || !data.account ? (
            <p className="mt-2 text-sm text-warn">AWS didn&apos;t answer the account check. Try again in a few minutes.</p>
          ) : (
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Access</dt>
                <dd>{data.account.sandbox ? <Badge tone="warn">SMS sandbox</Badge> : <Badge tone="good">Production</Badge>}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Tier</dt>
                <dd>{data.account.tier || "—"}</dd>
              </div>
              {data.account.spendLimitUsd !== undefined && data.account.spendLimitUsd !== null && (
                <div>
                  <dt className="text-xs text-muted">AWS monthly spend limit</dt>
                  <dd>
                    {fmtUsd(data.account.spendLimitUsd)}
                    {data.account.spendLimitMaxUsd ? <span className="text-xs text-muted"> (up to {fmtUsd(data.account.spendLimitMaxUsd)})</span> : null}
                  </dd>
                </div>
              )}
            </dl>
          )}
          {data.account?.sandbox && <p className="mt-2 text-xs text-muted">In the sandbox AWS only delivers to verified test numbers, whatever else is set up.</p>}
          <p className="mt-3 text-sm">
            <span className="text-xs text-muted">Delivery reports (configuration set): </span>
            {data.configurationSet ?? <span className="text-warn">none set, so delivery reports and prices won&apos;t arrive</span>}
          </p>
        </section>

        <section className="card animate-rise" aria-labelledby="snd-status-h">
          <h2 id="snd-status-h" className="flex flex-wrap items-center gap-2 font-semibold">
            Sender {s ? <Badge tone={check.tone}>{check.label}</Badge> : <Badge tone="neutral">Not set up</Badge>}
          </h2>
          {!s ? (
            <p className="mt-2 text-sm text-muted">Fill in the settings below and save, then check the sender with AWS.</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted">{check.help}</p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Shows as</dt>
                  <dd>{s.identityLabel ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Registration</dt>
                  <dd>{REGISTRATION[s.registrationStatus] ?? s.registrationStatus}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">AWS region</dt>
                  <dd>{s.awsRegion}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Replies (STOP)</dt>
                  <dd>{s.twoWay ? "Two-way: customers can reply STOP" : "One-way: opt-out link only"}</dd>
                </div>
                {s.identityStatus && (
                  <div>
                    <dt className="text-xs text-muted">Status at AWS</dt>
                    <dd>{s.identityStatus}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs text-muted">Last checked</dt>
                  <dd>{fmtWhen(s.identityCheckedAt, tz)}</dd>
                </div>
              </dl>
              {held && (
                <p className="mt-3 text-sm text-warn">
                  Texts are held until {fmtWhen(s.heldUntil, tz)}
                  {s.heldReason ? `: ${skipLabel(s.heldReason)}` : ""}.
                </p>
              )}
              {manage && (
                <button type="button" className="btn-secondary mt-3" disabled={!!busy} onClick={() => void verify()}>
                  {busy === "verify" ? "Checking…" : "Check with AWS"}
                </button>
              )}
            </>
          )}
        </section>
      </div>

      {s && (
        <section className="card animate-rise" aria-labelledby="snd-switch-h">
          <h2 id="snd-switch-h" className="font-semibold">
            Switches
          </h2>
          <p className="mt-1 text-sm text-muted">Both are off until you turn them on. They need a sender verified with AWS and a budget above 0.</p>
          <ul className="mt-3 divide-y divide-border">
            {(
              [
                ["sending", "Send texts", s.sendingEnabled, "Approved workflows, campaigns and Send SMS can text customers. Off cancels texts that are waiting."],
                ["marketing", "Send marketing texts", s.marketingEnabled, data.marketingSwitch ? "Marketing workflows and campaigns, to customers subscribed to your SMS marketing." : "Marketing texts aren't switched on for bizinsights yet."],
              ] as const
            ).map(([kind, label, on, help]) => {
              const blocked = !on && (!verified || !(s.monthlyBudgetUsd > 0) || (kind === "marketing" && !s.sendingEnabled));
              return (
                <li key={kind} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {label} <Badge tone={on ? "good" : "neutral"}>{on ? "On" : "Off"}</Badge>
                    </p>
                    <p className="text-xs text-muted">{help}</p>
                    {blocked && manage && (
                      <p className="mt-0.5 text-xs text-warn">
                        {!verified ? "Check the sender with AWS first." : !(s.monthlyBudgetUsd > 0) ? "Set a monthly budget first." : "Turn sending on first."}
                      </p>
                    )}
                  </div>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      role="switch"
                      className="h-4 w-4 accent-[var(--accent)]"
                      checked={on}
                      disabled={!manage || !!busy || blocked}
                      onChange={() => setSwitching({ kind, on: !on })}
                    />
                    <span className="sr-only">{label}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <SenderForm data={data} onSaved={reload} />
      {manage && <TestNumbers mode={data.mode} />}
      {s && (
        <p className="text-xs text-muted">
          Limits: at most {fmtNum(s.maxPerCustomerDay)} text{s.maxPerCustomerDay === 1 ? "" : "s"} per customer a day and {fmtNum(s.maxMarketingPerWeek)} marketing text
          {s.maxMarketingPerWeek === 1 ? "" : "s"} a week; quiet from {fmtHour(s.quietStart)} to {fmtHour(s.quietEnd)} for campaigns and Send SMS. Workflows keep their own quiet hours, and these daily and weekly limits apply to every text.
        </p>
      )}

      <ConfirmDialog
        open={!!switching}
        title={
          switching?.kind === "sending" ? (switching.on ? "Turn sending on?" : "Turn sending off?") : switching?.on ? "Turn marketing texts on?" : "Turn marketing texts off?"
        }
        confirmLabel={switching?.on ? "Turn on" : "Turn off"}
        danger={!switching?.on}
        busy={!!busy}
        onCancel={() => setSwitching(null)}
        onConfirm={() => switching && void toggle(switching.kind, switching.on)}
      >
        {switching?.kind === "sending" ? (
          switching.on ? (
            <p>Approved workflows that aren&apos;t dry runs, scheduled campaigns and Send SMS start texting customers who may receive them{data.mode === "sandbox" ? " (in test mode, only your verified test numbers)" : ""}.</p>
          ) : (
            <p>No more texts go out. Texts waiting to go are cancelled, not kept for later.</p>
          )
        ) : switching?.on ? (
          <p>Marketing workflows and scheduled campaigns can text customers subscribed to your SMS marketing in Shopify. Every marketing text carries the opt-out link.</p>
        ) : (
          <p>No more marketing texts go out. Order updates continue.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
