"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHeader, useAction } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
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
 * The Stitch design leaves this page undrawn ("Still not designed"): it has the Stock pages' cards
 * and headings.
 */
export default function StockSettingsPage() {
  const { base, status } = useInventory();
  const { data, error, loading, reload, setData } = useApi<{ settings: InventorySettingsView }>(`${base}/settings`);
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
        <div className="skeleton h-64 rounded-lg" />
      ) : (
        <>
          <Card id="alerts" title="Low stock and alerts">
            <div className="space-y-4">
              <p className="-mt-2 text-sm text-muted">
                An item is low when its available units, counting every location, are at or below the threshold; out at 0 or below. An item or a product can have its own threshold, set from its panel. People are told once when an item becomes low or sells out, not again while it stays that way. Alerts start once stock levels are connected or these settings are saved.
              </p>
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
                    <p className="text-xs text-muted sm:col-span-2">
                      A short text from the store&apos;s connected WhatsApp (
                      <Link href="/dashboard/whatsapp-automation" className="underline">
                        WhatsApp Automation
                      </Link>
                      ), within its sending hours and daily limit, at most one an hour to each number. Nothing is sent while WhatsApp isn&apos;t connected. On Meta&apos;s Cloud API, it reaches only people who wrote to that number in the last 24 hours.
                    </p>
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
            </div>
          </Card>

          <Card id="checks" title="Checks against Shopify and restock planning">
            <div className="space-y-4">
              <p className="-mt-2 text-sm text-muted">
                Shopify tells bizinsights about each stock change as it happens. On top of that, every stock level is read again on this schedule and compared with Shopify; any difference is corrected and shown in the stock history. The lead time and the days of sales to cover work out the suggested order on the Inventory overview, Low stock and Out of stock pages.
              </p>
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
            </div>
          </Card>

          <section className="space-y-3" aria-labelledby="access-h">
            <h2 id="access-h" className="home-h2 px-1 pt-2">
              Shopify access
            </h2>
            {inventoryCaps.map((c) => {
              const state = status?.capabilities.find((x) => x.id === c.id);
              return state?.enabled ? (
                <div key={c.id} className="home-card flex items-start gap-3 p-5 text-sm sm:p-6">
                  <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-good" />
                  <div className="min-w-0">
                    <p className="font-semibold">{c.title}: on</p>
                    <p className="mt-0.5 text-muted">
                      {c.description} Granted in Shopify: {c.requiredScopes.map(scopeLabel).join(", ").toLowerCase()}.
                    </p>
                  </div>
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
