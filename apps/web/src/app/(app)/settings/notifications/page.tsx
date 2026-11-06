"use client";
import Link from "next/link";
import { useState } from "react";
import { BellRing, Zap } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { Skeleton } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { canOpenPage } from "@/lib/access";
import { actionError, api, useApi } from "@/lib/api";
import { ZAPIER_CARD } from "@/lib/features";

// ---------------------------------------------------------------------------
// Settings → Notifications, as the Stitch design's screen 33 draws it: "Your emails" (a switch per
// email bizinsights sends, each person's own), the bell, and, for a bigger-order email bizinsights
// doesn't send itself, Zapier's Order paid trigger.
// ---------------------------------------------------------------------------

type Prefs = { syncFailures: boolean; weeklyDigest: boolean; productNews: boolean; stockAlerts: boolean };
/**
 * Only emails bizinsights actually sends. The preferences API also stores `weeklyDigest` and
 * `productNews`, but nothing sends either yet, so offering them promised a Monday email that never
 * came. List them here once their senders exist.
 */
const LABELS: Array<[keyof Prefs, string, string]> = [
  ["syncFailures", "Sync problems", "Email me if a store stops syncing (owners and admins)."],
  ["stockAlerts", "Stock alerts", "Email me when items run low or sell out (for people who can see inventory)."],
];

export default function NotificationsPage() {
  const { workspace, allowed, offers, access, me } = useApp();
  // Stock alerts go only to people who can see the stock.
  const labels = LABELS.filter(([k]) => k !== "stockAlerts" || (offers("inventory") && allowed("inventory.view")));
  const { data, setData, error, loading, reload } = useApi<{ preferences: Prefs }>(`/workspaces/${workspace.id}/notifications`);
  const [saveError, setSaveError] = useState<string | null>(null);
  const prefs = data?.preferences;
  const opens = (path: string) => canOpenPage(path, access, workspace.staffRole ?? null, !!me.shared, offers);
  // Where the low-stock level is set, and the Zapier card, for a member who may open them.
  const stockSettings = opens("/inventory/settings");
  const zapier = ZAPIER_CARD && offers("zapier") && opens("/settings/integrations");

  async function toggle(k: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [k]: !prefs[k] };
    setData({ preferences: next });
    setSaveError(null);
    await api(`/workspaces/${workspace.id}/notifications`, { method: "PUT", body: next }).catch((e) => {
      // Flipping the box back on its own reads as a misclick; say the change didn't save.
      setData({ preferences: prefs });
      setSaveError(actionError(e, "save that change"));
    });
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Notifications</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">What bizinsights tells you about, and where.</p>
      </header>

      <section aria-labelledby="your-emails-h">
        <h2 id="your-emails-h" className="home-h2 mb-3">
          Your emails
        </h2>
        {!prefs && error && <LoadError what="your notification settings" error={error} onRetry={() => void reload()} busy={loading} />}
        {saveError && <Alert>{saveError}</Alert>}
        {!prefs && !error && (
          <div className="home-card p-5">
            <Skeleton lines={2} />
          </div>
        )}
        {prefs && (
          <ul className="home-card animate-rise divide-y divide-home-line">
            {labels.map(([k, title, help]) => (
              <li key={k} className="flex items-center justify-between gap-4 px-4 py-3.5 sm:px-5">
                <div className="min-w-0">
                  <label htmlFor={`notify-${k}`} className="block cursor-pointer text-sm font-medium">
                    {title}
                  </label>
                  <p id={`notify-${k}-help`} className="text-xs text-muted">
                    {help}
                    {k === "stockAlerts" && stockSettings && (
                      <>
                        {" "}
                        The level is set in{" "}
                        <Link className="font-medium text-accent hover:underline" href="/inventory/settings">
                          Stock settings
                        </Link>
                        .
                      </>
                    )}
                  </p>
                </div>
                {/* A switch, as the design draws it: still a checkbox, named by its label. */}
                <span className="relative inline-flex shrink-0">
                  <input
                    id={`notify-${k}`}
                    type="checkbox"
                    role="switch"
                    aria-describedby={`notify-${k}-help`}
                    className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                    checked={prefs[k] ?? true}
                    onChange={() => toggle(k)}
                  />
                  <span
                    aria-hidden
                    className="h-6 w-11 rounded-full bg-home-tag transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"
                  />
                  <span aria-hidden className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-surface shadow-[var(--shadow)] transition-transform peer-checked:translate-x-5 motion-reduce:transition-none" />
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted">Each person chooses their own emails.</p>
      </section>

      <section aria-labelledby="bell-h" className="home-card animate-rise flex items-start gap-3 p-5 sm:p-6">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-home-soft text-muted">
          <BellRing className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <h2 id="bell-h" className="home-h2">
            The bell
          </h2>
          <p className="mt-0.5 text-sm text-muted">At the top of every page: it shows open problems until they&apos;re fixed, and the last week&apos;s notes.</p>
        </div>
      </section>

      {zapier && (
        <section aria-label="Emails bizinsights doesn't send" className="home-card animate-rise flex flex-wrap items-center gap-3 p-5 sm:p-6">
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-home-soft text-muted">
            <Zap className="h-4 w-4" />
          </span>
          <p className="min-w-0 flex-1 basis-60 text-sm">Want an email for big orders? Use Zapier&apos;s Order paid trigger.</p>
          <Link className="home-btn" href="/settings/integrations">
            Open Zapier
            <span className="sr-only"> on Settings → Integrations</span>
          </Link>
        </section>
      )}
    </div>
  );
}
