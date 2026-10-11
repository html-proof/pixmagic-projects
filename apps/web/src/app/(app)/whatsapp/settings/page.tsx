"use client";
import { useEffect, useState } from "react";
import type { TransactionalBasis } from "@app/shared/whatsapp";
import { Stat } from "@/components/dashboard/primitives";
import { hourLabel } from "@/components/dashboard/format";
import { useApp } from "@/components/AppContext";
import { LoadError } from "@/components/LoadError";
import { actionError, api, fmtNum, useApi } from "@/lib/api";
import { PageHeader, Skeleton, useAction, useSettings, useToast, useWa, type SettingsResponse } from "@/components/whatsapp/common";

const BASES: Array<{ id: TransactionalBasis; title: string; body: string }> = [
  { id: "none", title: "Not chosen yet", body: "No order or delivery updates are sent." },
  {
    id: "checkout_notice",
    title: "My checkout tells customers they'll get order updates on WhatsApp",
    body: "Every customer who gives a phone number gets updates about their own orders. Choose this only if your checkout or order confirmation clearly says so, and how to stop them (reply STOP).",
  },
  {
    id: "cart_attribute",
    title: "Only customers who tick a WhatsApp box on my store",
    body: "Updates go only to orders carrying the cart attribute whatsapp_opt_in = yes (a checkbox on your cart page; docs/whatsapp.md has the snippet), or to customers who opted in on WhatsApp.",
  },
  {
    id: "sms_consent",
    title: "Only customers who accepted text-message marketing in Shopify",
    body: "Uses Shopify's SMS marketing checkbox. The narrowest choice: many customers who'd like order updates won't get them.",
  },
];

interface ContactSummary {
  contacts: number;
  marketingEligible: number;
  optedInViaShopifySms: number;
  marketingOptedOut: number;
  optedOutOfEverything: number;
}

export default function WhatsappSettings() {
  const { base, manage, contact } = useWa();
  const { store } = useApp();
  const { data, error, reload, save } = useSettings();
  const summary = useApi<ContactSummary>(base ? `${base}/contacts/summary` : null);
  const toast = useToast();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<SettingsResponse["config"] | null>(null);
  const [attested, setAttested] = useState(false);
  const [optOut, setOptOut] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) {
      setDraft(data.config);
      setAttested(data.config.transactionalBasis === "checkout_notice");
    }
  }, [data]);
  if (error) return <LoadError what="the WhatsApp settings" error={error} onRetry={() => void reload()} />;
  if (!data || !draft) return <Skeleton lines={6} />;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const needsAttest = draft.transactionalBasis === "checkout_notice" && data.config.transactionalBasis !== "checkout_notice" && !attested;
  const set = <K extends keyof SettingsResponse["config"]>(k: K, v: SettingsResponse["config"][K]) => setDraft({ ...draft, [k]: v });
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const onSave = async () => {
    setSaving(true);
    try {
      await save(draft);
      toast("success", "Settings saved.");
    } catch (e) {
      toast("error", actionError(e, "save the settings"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="WhatsApp settings" sub={<>Applies to {store?.name ?? store?.shopDomain}. Times are in the store&apos;s time zone ({store?.timezone}).</>} />

      <fieldset className="card space-y-3" disabled={!manage}>
        <legend className="sr-only">Consent for order updates</legend>
        <div>
          <h2 className="font-semibold">Who may get order and delivery updates</h2>
          <p className="mt-1 text-sm text-muted">
            WhatsApp requires customers to agree before a business messages them, and Shopify&apos;s checkout doesn&apos;t ask on its own. Say how your customers agree; nothing is
            sent until you do. Anyone who replies STOP never gets another message, whatever you choose.
          </p>
          {data.basisSetAt && <p className="mt-1 text-xs text-muted">Last changed {new Date(data.basisSetAt).toLocaleString()} (recorded in the audit log).</p>}
        </div>
        <div className="space-y-2">
          {BASES.map((b) => (
            <label key={b.id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 ${draft.transactionalBasis === b.id ? "border-accent bg-accent/5" : "border-border"}`}>
              <input type="radio" name="basis" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={draft.transactionalBasis === b.id} onChange={() => set("transactionalBasis", b.id)} />
              <span>
                <span className="block text-sm font-medium">{b.title}</span>
                <span className="block text-xs text-muted">{b.body}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.transactionalBasis === "checkout_notice" && data.config.transactionalBasis !== "checkout_notice" && (
          <label className="flex items-start gap-2 rounded-lg border border-warn/60 p-3 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
            <span>I confirm my checkout tells customers they&apos;ll receive order updates on WhatsApp from this store, and that they can reply STOP to end them.</span>
          </label>
        )}
      </fieldset>

      <fieldset className="card space-y-4" disabled={!manage}>
        <legend className="sr-only">Marketing</legend>
        <h2 className="font-semibold">Marketing messages (campaigns and cart reminders)</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--accent)]" checked={draft.smsConsentCountsForMarketing} onChange={(e) => set("smsConsentCountsForMarketing", e.target.checked)} />
          <span>
            Count Shopify&apos;s text-message marketing consent as WhatsApp marketing consent
            <span className="block text-xs text-muted">Only if the consent wording on your store mentions WhatsApp. Otherwise customers opt in on WhatsApp itself (by replying START).</span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label" htmlFor="s-from">Send from</label>
            <select id="s-from" className="input" value={draft.sendWindowStart} onChange={(e) => set("sendWindowStart", Number(e.target.value))}>
              {hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-to">Until</label>
            <select id="s-to" className="input" value={draft.sendWindowEnd} onChange={(e) => set("sendWindowEnd", Number(e.target.value))}>
              {hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="s-cap">At most per customer per week</label>
            <input id="s-cap" className="input" type="number" min={1} max={14} value={draft.marketingPerWeek} onChange={(e) => set("marketingPerWeek", Number(e.target.value) || 1)} />
          </div>
          <div>
            <label className="label" htmlFor="s-attr">Credit orders within (days)</label>
            <input id="s-attr" className="input" type="number" min={1} max={14} value={draft.attributionDays} onChange={(e) => set("attributionDays", Number(e.target.value) || 1)} />
          </div>
        </div>
        <p className="text-xs text-muted">Marketing messages due outside these hours wait for the next window. Order and delivery updates go out straight away.</p>
      </fieldset>

      <fieldset className="card space-y-3" disabled={!manage}>
        <legend className="sr-only">Orders</legend>
        <h2 className="font-semibold">Order steps and support</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="s-ptag">&ldquo;Processing&rdquo; tag in Shopify</label>
            <input id="s-ptag" className="input" maxLength={40} value={draft.processingTag} onChange={(e) => set("processingTag", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-ktag">&ldquo;Packed&rdquo; tag in Shopify</label>
            <input id="s-ktag" className="input" maxLength={40} value={draft.packedTag} onChange={(e) => set("packedTag", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-sp">Support phone (shown on tracking pages)</label>
            <input id="s-sp" className="input" type="tel" maxLength={40} value={draft.supportPhone} onChange={(e) => set("supportPhone", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="s-se">Support email</label>
            <input id="s-se" className="input" type="email" maxLength={200} value={draft.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} />
          </div>
        </div>
      </fieldset>

      {manage && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" disabled={!dirty || saving || needsAttest} onClick={() => void onSave()}>{saving ? "Saving…" : "Save settings"}</button>
          {dirty && <button type="button" className="btn-secondary" onClick={() => setDraft(data.config)}>Discard changes</button>}
          {needsAttest && <span className="text-xs text-warn">Tick the confirmation above first.</span>}
        </div>
      )}

      <section className="card space-y-3" aria-labelledby="consent-h">
        <h2 id="consent-h" className="font-semibold">Consent and opt-outs</h2>
        {summary.data ? (
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Customers with a WhatsApp number" value={fmtNum(summary.data.contacts)} />
            <Stat label="Can receive marketing" value={fmtNum(summary.data.marketingEligible)} note={summary.data.optedInViaShopifySms && !draft.smsConsentCountsForMarketing ? `${fmtNum(summary.data.optedInViaShopifySms)} more with Shopify SMS consent only` : undefined} />
            <Stat label="Stopped marketing" value={fmtNum(summary.data.marketingOptedOut)} />
            <Stat label="Replied STOP (nothing is sent)" value={fmtNum(summary.data.optedOutOfEverything)} />
          </div>
        ) : summary.error ? (
          <LoadError what="the consent summary" error={summary.error} onRetry={() => void summary.reload()} />
        ) : (
          <div className="skeleton h-20" />
        )}
        {contact && (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("optout", "record the opt-out", async () => {
                const r = await api<{ phoneMasked: string }>(`${base}/contacts/opt-out`, { method: "POST", body: { phone: optOut } });
                setOptOut("");
                await summary.reload();
                return `${r.phoneMasked} won't receive any more WhatsApp messages from this store.`;
              });
            }}
          >
            <div>
              <label className="label" htmlFor="s-oo">Record an opt-out a customer gave you another way</label>
              <input id="s-oo" className="input w-64" type="tel" placeholder="+91 98765 43210" required value={optOut} onChange={(e) => setOptOut(e.target.value)} />
            </div>
            <button type="submit" className="btn-secondary" disabled={!!busy}>{busy === "optout" ? "Saving…" : "Stop messages to this number"}</button>
          </form>
        )}
        <p className="text-xs text-muted">
          Customers stop everything by replying STOP, and marketing only with the &ldquo;Stop promotions&rdquo; button or WhatsApp&apos;s own setting. Opt-outs are kept for as long
          as the store uses WhatsApp, so they&apos;re never messaged again by mistake.
        </p>
      </section>

      <section className="card text-sm text-muted">
        <h2 className="font-semibold text-text">Data Insights keeps for WhatsApp</h2>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>Customers&apos; WhatsApp numbers and first names, encrypted, to send their messages and honour opt-outs. The dashboard only shows masked numbers.</li>
          <li>Message history for 180 days; the details used to write a message are deleted once it&apos;s sent.</li>
          <li>Unfinished checkouts: the checkout link and name are deleted after 30 days, the rest after 90.</li>
          <li>Order timelines for a year; tracking links stop working after 120 days.</li>
          <li>When Shopify asks to erase a customer, or your store, all of it is deleted.</li>
        </ul>
      </section>
    </div>
  );
}
