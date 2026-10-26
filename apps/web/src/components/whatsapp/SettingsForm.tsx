"use client";
import { useId, useMemo, useState } from "react";
import { WA_ORDER_UPDATE_BASES, WA_ORDER_UPDATE_INFO, WA_PER_CUSTOMER_DAILY, type WaOrderUpdateBasis } from "@app/shared/whatsapp";
import { fmtHour } from "@/components/messaging/MessagingUi";
import { api } from "@/lib/api";
import type { WaOverview } from "./types";
import { useWaAction } from "./WaUi";

// Step 3 (Configure) and Settings: the business name customers read, how they agree to messages,
// marketing, sending hours and their time zone, daily limits and how long texts are kept.

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}

export function SettingsForm({ base, overview, onSaved, submitLabel = "Save settings" }: { base: string; overview: WaOverview; onSaved: () => void; submitLabel?: string }) {
  const id = useId();
  const s = overview.settings;
  const { busy, run } = useWaAction();
  const zones = useMemo(timeZones, []);
  const [form, setForm] = useState({
    businessName: s.businessName ?? "",
    orderUpdates: s.orderUpdates,
    marketingEnabled: s.marketingEnabled,
    shopifySmsConsent: s.shopifySmsConsent,
    start: s.sendWindow.start,
    end: s.sendWindow.end,
    timeZone: s.timeZoneSet ?? "",
    dailyLimit: String(s.dailyLimit ?? overview.limits.dailyLimit),
    perCustomer: String(s.perCustomerDailyLimit),
    retentionDays: String(s.retentionDays),
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const readOnly = !overview.can.manage;
  const daily = Number(form.dailyLimit);
  const dailyOk = Number.isInteger(daily) && daily >= 1 && daily <= overview.limits.dailyMax;
  const sameHours = form.start === form.end;

  const save = () =>
    run("save", "save the WhatsApp settings", async () => {
      await api(`${base}/settings`, {
        method: "PUT",
        body: {
          businessName: form.businessName.trim() || null,
          orderUpdates: form.orderUpdates,
          marketingEnabled: form.marketingEnabled,
          shopifySmsConsent: form.shopifySmsConsent,
          sendWindow: { start: form.start, end: form.end },
          timeZone: form.timeZone.trim() || null,
          dailyLimit: daily,
          perCustomerDailyLimit: Number(form.perCustomer),
          retentionDays: Number(form.retentionDays),
        },
      });
      onSaved();
      return "WhatsApp settings saved.";
    });

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!readOnly && dailyOk && !sameHours) void save();
      }}
    >
      <fieldset disabled={readOnly || busy === "save"} className="space-y-5">
        <div>
          <label className="label" htmlFor={`${id}-name`}>
            Business name customers see
          </label>
          <input id={`${id}-name`} className="input max-w-md" maxLength={60} placeholder={overview.store.name} value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
          <p className="mt-1 text-xs text-muted">What {"{{store_name}}"} says in your messages. Empty: your store&apos;s name.</p>
        </div>

        <fieldset>
          <legend className="label">How customers agree to order updates</legend>
          <div className="space-y-2">
            {WA_ORDER_UPDATE_BASES.filter((b) => b !== "unset").map((b) => (
              <label key={b} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${form.orderUpdates === b ? "border-accent bg-accent/5" : "border-border"}`}>
                <input type="radio" name={`${id}-basis`} className="mt-1" checked={form.orderUpdates === b} onChange={() => set("orderUpdates", b as WaOrderUpdateBasis)} />
                <span>
                  <span className="font-medium">{WA_ORDER_UPDATE_INFO[b].label}</span>
                  <span className="block text-muted">{WA_ORDER_UPDATE_INFO[b].help}</span>
                </span>
              </label>
            ))}
          </div>
          {form.orderUpdates === "unset" && <p className="mt-2 text-sm text-warn">Choose one: order updates can&apos;t be sent until you do.</p>}
        </fieldset>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.marketingEnabled} onChange={(e) => set("marketingEnabled", e.target.checked)} />
            <span>
              <span className="font-medium">Send marketing messages</span>
              <span className="block text-muted">Cart reminders, welcomes and campaigns, only to customers who agreed to marketing. Every marketing message tells them how to stop.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.shopifySmsConsent} onChange={(e) => set("shopifySmsConsent", e.target.checked)} />
            <span>
              <span className="font-medium">Shopify&apos;s text-message consent covers WhatsApp</span>
              <span className="block text-muted">Tick only if the wording customers agree to in your checkout mentions WhatsApp. Then their Shopify marketing consent counts here too.</span>
            </span>
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor={`${id}-start`}>
              Send from
            </label>
            <select id={`${id}-start`} className="input" value={form.start} onChange={(e) => set("start", Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {fmtHour(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-end`}>
              Until
            </label>
            <select id={`${id}-end`} className="input" value={form.end} onChange={(e) => set("end", Number(e.target.value))}>
              {[...HOURS.slice(1), 24].map((h) => (
                <option key={h} value={h}>
                  {h === 24 ? "Midnight" : fmtHour(h)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-tz`}>
              Time zone
            </label>
            <input id={`${id}-tz`} className="input" list={`${id}-zones`} placeholder={`${overview.store.timezone} (your store's)`} value={form.timeZone} onChange={(e) => set("timeZone", e.target.value)} />
            <datalist id={`${id}-zones`}>
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
        </div>
        <p className="-mt-3 text-xs text-muted">
          Every automation waits for these hours, order updates included, and so do campaigns and stock alerts to your team. Messages you send yourself, the replies to STOP and START, tests and
          codes go at once.
          {sameHours && <span className="block text-danger">The start and end can&apos;t be the same hour.</span>}
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor={`${id}-daily`}>
              Messages a day (most)
            </label>
            <input id={`${id}-daily`} className="input" type="number" min={1} max={overview.limits.dailyMax} value={form.dailyLimit} onChange={(e) => set("dailyLimit", e.target.value)} aria-invalid={!dailyOk} />
            <p className="mt-1 text-xs text-muted">Up to {new Intl.NumberFormat().format(overview.limits.dailyMax)} on this connection. Replies and tests don&apos;t count.</p>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-per`}>
              Per customer a day
            </label>
            <select id={`${id}-per`} className="input" value={form.perCustomer} onChange={(e) => set("perCustomer", e.target.value)}>
              {Array.from({ length: WA_PER_CUSTOMER_DAILY.max }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`${id}-keep`}>
              Keep message texts for
            </label>
            <select id={`${id}-keep`} className="input" value={form.retentionDays} onChange={(e) => set("retentionDays", e.target.value)}>
              {[7, 30, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">After that only the record (when, to whom masked, its status) stays.</p>
          </div>
        </div>
      </fieldset>
      {readOnly ? (
        <p className="text-sm text-muted">Only the store&apos;s owners and admins can change these.</p>
      ) : (
        <button type="submit" className="btn-primary" disabled={busy === "save" || !dailyOk || sameHours}>
          {busy === "save" ? "Saving…" : submitLabel}
        </button>
      )}
    </form>
  );
}
