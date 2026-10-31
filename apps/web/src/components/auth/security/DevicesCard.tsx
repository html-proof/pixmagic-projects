"use client";
import { useCallback, useState } from "react";
import { ChevronDown, LogOut, MonitorSmartphone, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { useApi } from "@/lib/api";
import { authErrorMessage, removeDevice, type SignedInDevice } from "@/lib/auth";
import { CardHeader, day, DeviceIcon, Pill, Place, time, tone, type Msg } from "./ui";

/** GET /auth/account/sessions, loaded by the page (a password change reloads it). */
export const useDevices = () => useApi<{ sessions: SignedInDevice[] }>("/auth/account/sessions");
type DevicesQuery = ReturnType<typeof useDevices>;

/** How many devices show before "Show more devices". */
const FIRST = 5;

/**
 * Where the account is signed in: this device first, then the others by when they were last used,
 * each with its browser, address and place; any other one can be signed out from here.
 */
export function DevicesCard({ q, onSignOutAll }: { q: DevicesQuery; onSignOutAll: () => void }) {
  const [all, setAll] = useState(false);
  const [removing, setRemoving] = useState<SignedInDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const cancel = useCallback(() => setRemoving(null), []);
  const devices = q.data?.sessions ?? [];
  const shown = all ? devices : devices.slice(0, FIRST);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setMsg(null);
    try {
      await removeDevice(removing.id);
      q.setData({ sessions: devices.filter((s) => s.id !== removing.id) });
      setMsg({ kind: "success", text: `${removing.device.name} is signed out.` });
    } catch (err) {
      setMsg({ kind: "error", text: authErrorMessage(err) });
      void q.reload();
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  return (
    <section aria-labelledby="devices-h" className="card overflow-hidden p-0">
      <div className="p-5">
        <CardHeader
          id="devices-h"
          t="info"
          icon={MonitorSmartphone}
          title="Your sign-in devices"
          sub="These are the devices currently signed in to your account. You can remove any device at any time."
          action={
            <button type="button" className="tone-button min-h-10" style={tone("info")} onClick={onSignOutAll}>
              <LogOut size={16} aria-hidden />
              Sign out of all devices
            </button>
          }
        />
        {msg && (
          <div className="mt-4">
            <Alert kind={msg.kind} onDismiss={() => setMsg(null)}>
              {msg.text}
            </Alert>
          </div>
        )}
      </div>
      {q.error && !q.data ? (
        <div className="px-5 pb-5">
          <LoadError what="your devices" error={q.error} onRetry={() => void q.reload()} busy={q.loading} />
        </div>
      ) : !q.data ? (
        <div className="space-y-3 px-5 pb-5" aria-busy="true" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-12" />
          ))}
        </div>
      ) : (
        <div className="@container">
          {/* A table where there's room for one; a list of cards on a phone or a narrow column. */}
          <table className="hidden w-full text-left text-sm @4xl:table">
            <thead className="border-y border-border bg-bg/60 text-xs font-semibold text-muted">
              <tr>
                <th scope="col" className="py-3 pr-3 pl-5 font-semibold">Device</th>
                <th scope="col" className="px-3 py-3 font-semibold">Model / Browser</th>
                <th scope="col" className="px-3 py-3 font-semibold">IP Address</th>
                <th scope="col" className="px-3 py-3 font-semibold">Location</th>
                <th scope="col" className="px-3 py-3 font-semibold">Last active</th>
                <th scope="col" className="px-3 py-3 font-semibold">Status</th>
                <th scope="col" className="py-3 pr-5 pl-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className={`border-b border-border last:border-b-0 ${d.current ? "bg-[color-mix(in_oklab,var(--info)_6%,transparent)]" : ""}`}>
                  <td className="py-3 pr-3 pl-5">
                    <span className="flex items-center gap-3">
                      <DeviceIcon kind={d.device.kind} />
                      <span className="font-medium whitespace-nowrap">{d.device.name}</span>
                      {d.current && <Pill t="info">Current device</Pill>}
                    </span>
                  </td>
                  <td className="px-3 py-3 leading-tight">
                    <span className="block">{d.device.browser ?? "Unknown browser"}</span>
                    {d.device.os && <span className="block text-muted">{d.device.os}</span>}
                  </td>
                  <td className="px-3 py-3 font-mono text-[13px] tabular-nums">{d.ip ?? <span className="font-sans text-muted">Unknown</span>}</td>
                  <td className="max-w-56 px-3 py-3">
                    <Place place={d.location} />
                  </td>
                  <td className="px-3 py-3 leading-tight whitespace-nowrap">
                    <LastActive device={d} />
                  </td>
                  <td className="px-3 py-3">{d.current ? <Pill t="good">This device</Pill> : <Pill t="good">Active</Pill>}</td>
                  <td className="py-3 pr-5 pl-3">
                    {d.current ? (
                      <span className="text-muted" aria-label="Sign out of this device below">
                        —
                      </span>
                    ) : (
                      <RemoveButton device={d} onClick={() => setRemoving(d)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y divide-border border-t border-border @4xl:hidden">
            {shown.map((d) => (
              <li key={d.id} className={`flex items-start gap-3 px-5 py-4 text-sm ${d.current ? "bg-[color-mix(in_oklab,var(--info)_6%,transparent)]" : ""}`}>
                <DeviceIcon kind={d.device.kind} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.device.name}</span>
                    {d.current && <Pill t="info">Current device</Pill>}
                  </p>
                  <p className="text-muted">{[d.device.browser, d.device.os].filter(Boolean).join(" · ") || "Unknown browser"}</p>
                  <div className="text-muted">
                    <Place place={d.location} compact />
                  </div>
                  <p className="text-muted">
                    {d.ip && <span className="font-mono text-[13px]">{d.ip} · </span>}
                    <LastActive device={d} inline />
                  </p>
                </div>
                {!d.current && <RemoveButton device={d} onClick={() => setRemoving(d)} />}
              </li>
            ))}
          </ul>
          {devices.length > FIRST && (
            <div className="border-t border-border py-3 text-center">
              <button type="button" className="inline-flex items-center gap-1.5 text-sm font-medium text-info hover:underline" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer devices" : `Show more devices (${devices.length - FIRST})`}
                <ChevronDown size={16} aria-hidden className={`transition-transform ${all ? "rotate-180" : ""}`} />
              </button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        title={`Sign out ${removing?.device.name ?? "this device"}?`}
        confirmLabel={busy ? "Signing out…" : "Remove"}
        danger
        busy={busy}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <p>{removing?.device.browser ? `${removing.device.browser} on ${removing.device.name}` : removing?.device.name} will be signed out straight away, and will have to sign in again.</p>
        <p>Don&apos;t recognise it? Change your password too.</p>
      </ConfirmDialog>
    </section>
  );
}

function RemoveButton({ device, onClick }: { device: SignedInDevice; onClick: () => void }) {
  return (
    <button type="button" className="btn-danger min-h-10 px-3.5" onClick={onClick} aria-label={`Remove ${device.device.name}${device.device.browser ? `, ${device.device.browser}` : ""}`}>
      <Trash2 size={16} aria-hidden />
      Remove
    </button>
  );
}

function LastActive({ device: d, inline = false }: { device: SignedInDevice; inline?: boolean }) {
  if (d.current) {
    return (
      <span className="inline-flex items-center gap-2 font-medium">
        <span className="size-2 rounded-full bg-fill-good" aria-hidden />
        Active now
      </span>
    );
  }
  if (inline) return <span>Last active {day(d.lastActiveAt)}, {time(d.lastActiveAt)}</span>;
  return (
    <>
      <span className="block">{day(d.lastActiveAt)}</span>
      <span className="block text-muted">{time(d.lastActiveAt)}</span>
    </>
  );
}
