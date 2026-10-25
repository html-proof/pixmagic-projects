"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, useAction } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Field } from "@/components/staff/ui";
import { ConnectCard, useInventory } from "@/components/inventory/InventoryUi";
import { api, useApi } from "@/lib/api";
import type { InventorySettingsView } from "@/lib/inventory";
import { CAPABILITIES, scopeLabel } from "@app/shared/capabilities";
import { INVENTORY_DEFAULTS } from "@app/shared/inventory";

/**
 * Stock settings: the low-stock threshold and how the team hears about stock (inventory.alerts),
 * how often stock is checked against Shopify and the restock planning (inventory.settings), and
 * the Shopify access the module has. Members without the permission see the values, read-only.
 */
export default function StockSettingsPage() {
  const { base, status } = useInventory();
  const { data, error, loading, reload, setData } = useApi<{ settings: InventorySettingsView }>(`${base}/settings`);
  const templates = useApi<{ templates: Array<{ name: string; language: string }> }>(status?.can.alerts ? `${base}/whatsapp-templates` : null);
  const { busy, run } = useAction();
  const s = data?.settings;
  const [alerts, setAlerts] = useState({ lowStockThreshold: "", emailAlerts: true, dashboardAlerts: true, whatsappAlerts: false, whatsappTemplate: "", numbers: "" });
  const [sync, setSync] = useState({ reconcileHours: "", leadTimeDays: "", coverDays: "" });
  useEffect(() => {
    if (!s) return;
    setAlerts({ lowStockThreshold: String(s.lowStockThreshold), emailAlerts: s.emailAlerts, dashboardAlerts: s.dashboardAlerts, whatsappAlerts: s.whatsappAlerts, whatsappTemplate: s.whatsappTemplate ?? "", numbers: "" });
    setSync({ reconcileHours: String(s.reconcileHours), leadTimeDays: String(s.leadTimeDays), coverDays: String(s.coverDays) });
  }, [s]);
  const canAlerts = !!status?.can.alerts;
  const canSettings = !!status?.can.settings;

  const saveAlerts = () =>
    run("alerts", "save the alert settings", async () => {
      const numbers = alerts.numbers
        .split(/[\s,;]+/)
        .map((n) => n.trim())
        .filter(Boolean);
      const r = await api<{ settings: InventorySettingsView }>(`${base}/settings/alerts`, {
        method: "PUT",
        body: {
          lowStockThreshold: Number(alerts.lowStockThreshold),
          emailAlerts: alerts.emailAlerts,
          dashboardAlerts: alerts.dashboardAlerts,
          whatsappAlerts: alerts.whatsappAlerts,
          whatsappTemplate: alerts.whatsappTemplate || null,
          ...(numbers.length ? { whatsappTo: numbers } : {}),
        },
      });
      setData(r);
      return "Alert settings saved.";
    });
  const saveSync = () =>
    run("sync", "save the stock settings", async () => {
      const r = await api<{ settings: InventorySettingsView }>(`${base}/settings`, {
        method: "PUT",
        body: { reconcileHours: Number(sync.reconcileHours), leadTimeDays: Number(sync.leadTimeDays), coverDays: Number(sync.coverDays) },
      });
      setData(r);
      return "Stock settings saved.";
    });
  const clearNumbers = () =>
    run("numbers", "remove the WhatsApp numbers", async () => {
      const r = await api<{ settings: InventorySettingsView }>(`${base}/settings/alerts`, {
        method: "PUT",
        body: { lowStockThreshold: Number(alerts.lowStockThreshold), emailAlerts: alerts.emailAlerts, dashboardAlerts: alerts.dashboardAlerts, whatsappAlerts: false, whatsappTemplate: alerts.whatsappTemplate || null, whatsappTo: [] },
      });
      setData(r);
      return "WhatsApp numbers removed.";
    });

  const inventoryCaps = CAPABILITIES.filter((c) => c.area === "inventory");
  return (
    <>
      <PageHeader title="Stock settings" sub={status?.store.name} />
      {error && !data ? (
        <LoadError what="the stock settings" error={error} onRetry={reload} busy={loading} />
      ) : !s ? (
        <div className="skeleton h-64 rounded-xl" />
      ) : (
        <>
          <section className="card space-y-4" aria-label="Low stock and alerts">
            <div>
              <h2 className="font-semibold">Low stock and alerts</h2>
              <p className="mt-0.5 text-sm text-muted">
                An item is low when its available units, counting every location, are at or below the threshold; out at 0 or below. An item or a product can have its own threshold, set from its panel. People are told once when an item becomes low or sells out, not again while it stays that way. Alerts start once stock levels are connected or these settings are saved.
              </p>
            </div>
            <fieldset disabled={!canAlerts} className="grid gap-4 sm:grid-cols-2">
              <Field label="Low-stock threshold (units)" htmlFor="threshold" hint={`Default ${INVENTORY_DEFAULTS.lowStockThreshold}.`}>
                <input id="threshold" className="input" inputMode="numeric" value={alerts.lowStockThreshold} onChange={(e) => setAlerts({ ...alerts, lowStockThreshold: e.target.value })} />
              </Field>
              <div className="space-y-2 text-sm">
                <div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={alerts.emailAlerts} onChange={(e) => setAlerts({ ...alerts, emailAlerts: e.target.checked })} />
                    Email the team
                  </label>
                  <p className="ml-6 text-xs text-muted">
                    Everyone who can see inventory, unless they turned off &ldquo;Stock alerts&rdquo; in{" "}
                    <Link href="/settings/notifications" className="underline">
                      Notifications
                    </Link>
                    .
                  </p>
                </div>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={alerts.dashboardAlerts} onChange={(e) => setAlerts({ ...alerts, dashboardAlerts: e.target.checked })} />
                  Show in the notification bell
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={alerts.whatsappAlerts} onChange={(e) => setAlerts({ ...alerts, whatsappAlerts: e.target.checked })} />
                  Send a WhatsApp message
                </label>
              </div>
              {alerts.whatsappAlerts && (
                <>
                  <Field label="WhatsApp template" htmlFor="wa-template" hint="An approved template with two variables: the store's name, then the alert. Write it from the starter “Stock alert (to your team)” in WhatsApp Automation → Message templates.">
                    <select id="wa-template" className="input" value={alerts.whatsappTemplate} onChange={(e) => setAlerts({ ...alerts, whatsappTemplate: e.target.value })}>
                      <option value="">Choose a template</option>
                      {templates.data?.templates.map((t) => (
                        <option key={`${t.name}:${t.language}`} value={t.name}>
                          {t.name} ({t.language})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Send to" htmlFor="wa-to" hint={s.whatsappTo.length ? `Now: ${s.whatsappTo.join(", ")}. Enter numbers to replace them.` : "Up to 5 numbers in international format, e.g. +61400000000."}>
                    <input id="wa-to" className="input" value={alerts.numbers} onChange={(e) => setAlerts({ ...alerts, numbers: e.target.value })} placeholder="+61400000000, +61400000001" />
                  </Field>
                </>
              )}
            </fieldset>
            {canAlerts ? (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={saveAlerts} disabled={busy !== null}>
                  {busy === "alerts" ? "Saving…" : "Save alert settings"}
                </button>
                {s.whatsappTo.length > 0 && (
                  <button type="button" className="btn-secondary" onClick={clearNumbers} disabled={busy !== null}>
                    Remove WhatsApp numbers
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted">Changing these needs the &ldquo;Manage stock alerts&rdquo; permission.</p>
            )}
          </section>

          <section className="card space-y-4" aria-label="Checks and restock planning">
            <div>
              <h2 className="font-semibold">Checks against Shopify and restock planning</h2>
              <p className="mt-0.5 text-sm text-muted">
                Shopify tells bizinsights about each stock change as it happens. On top of that, every stock level is read again on this schedule and compared with Shopify; any difference is corrected and shown in the stock history.
              </p>
            </div>
            <fieldset disabled={!canSettings} className="grid gap-4 sm:grid-cols-3">
              <Field label="Check every (hours)" htmlFor="reconcile" hint="1 to 24.">
                <input id="reconcile" className="input" inputMode="numeric" value={sync.reconcileHours} onChange={(e) => setSync({ ...sync, reconcileHours: e.target.value })} />
              </Field>
              <Field label="Supplier lead time (days)" htmlFor="lead" hint="How long a reorder takes to arrive.">
                <input id="lead" className="input" inputMode="numeric" value={sync.leadTimeDays} onChange={(e) => setSync({ ...sync, leadTimeDays: e.target.value })} />
              </Field>
              <Field label="Days of sales to cover" htmlFor="cover" hint="What a reorder should last once it arrives.">
                <input id="cover" className="input" inputMode="numeric" value={sync.coverDays} onChange={(e) => setSync({ ...sync, coverDays: e.target.value })} />
              </Field>
            </fieldset>
            {canSettings ? (
              <button type="button" className="btn-primary" onClick={saveSync} disabled={busy !== null}>
                {busy === "sync" ? "Saving…" : "Save stock settings"}
              </button>
            ) : (
              <p className="text-xs text-muted">Changing these needs the &ldquo;Manage inventory settings&rdquo; permission.</p>
            )}
          </section>

          <section className="space-y-3" aria-label="Shopify access">
            <h2 className="px-1 font-semibold">Shopify access</h2>
            {inventoryCaps.map((c) => {
              const state = status?.capabilities.find((x) => x.id === c.id);
              return state?.enabled ? (
                <div key={c.id} className="card text-sm">
                  <p className="font-medium">{c.title}: on</p>
                  <p className="text-muted">
                    {c.description} Granted in Shopify: {c.requiredScopes.map(scopeLabel).join(", ").toLowerCase()}.
                  </p>
                </div>
              ) : (
                <ConnectCard key={c.id} capability={c.id as "stock_levels" | "stock_adjustments"} />
              );
            })}
          </section>
        </>
      )}
    </>
  );
}
