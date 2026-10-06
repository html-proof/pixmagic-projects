"use client";
import { useState } from "react";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { LoadError } from "@/components/LoadError";
import { actionError, api, useApi } from "@/lib/api";

type Prefs = { syncFailures: boolean; weeklyDigest: boolean; productNews: boolean };
const LABELS: Array<[keyof Prefs, string, string]> = [
  ["syncFailures", "Sync problems", "Email me if a store stops syncing (owners and admins)."],
  ["weeklyDigest", "Weekly summary", "A Monday email with last week's key numbers."],
  ["productNews", "Product updates", "Occasional news about new features."],
];

export default function NotificationsPage() {
  const { workspace } = useApp();
  const { data, setData, error, loading, reload } = useApi<{ preferences: Prefs }>(`/workspaces/${workspace.id}/notifications`);
  const [saveError, setSaveError] = useState<string | null>(null);
  const prefs = data?.preferences;

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
    <section className="card space-y-4">
      <h1 className="text-lg font-semibold">Notifications</h1>
      {!prefs && error && <LoadError what="your notification settings" error={error} onRetry={() => void reload()} busy={loading} />}
      {saveError && <Alert>{saveError}</Alert>}
      {prefs &&
        LABELS.map(([k, title, help]) => (
          <label key={k} className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={prefs[k]} onChange={() => toggle(k)} />
            <span>
              <span className="block text-sm font-medium">{title}</span>
              <span className="block text-xs text-muted">{help}</span>
            </span>
          </label>
        ))}
    </section>
  );
}
