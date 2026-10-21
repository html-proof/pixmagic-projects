"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api } from "@/lib/api";

export default function ProfilePage() {
  const { me, reloadMe } = useApp();
  const [name, setName] = useState(me.user.displayName ?? "");
  const [tz, setTz] = useState(me.user.timezone);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  // Browsers' list omits "UTC" (every account's default), so a select without it showed the first
  // zone in the list (Africa/Abidjan) as the user's time zone. Keep UTC and the saved zone in it.
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const zones = [...new Set(["UTC", me.user.timezone, ...known])];

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/me", { method: "PATCH", body: { displayName: name, timezone: tz } });
    } catch (err) {
      return setMsg({ kind: "error", text: actionError(err, "save your profile") });
    }
    setMsg({ kind: "success", text: "Saved." });
    // The save landed; refreshing the shared copy of the profile is best effort (it retries itself).
    await reloadMe();
  }

  return (
    <section className="card space-y-4">
      <h1 className="text-lg font-semibold">Profile</h1>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={save} className="space-y-3">
        <div>
          <p className="label">Email</p>
          <p className="text-sm">{me.user.email} {me.user.emailVerified && <span className="text-good">· verified</span>}</p>
        </div>
        <div>
          <label className="label" htmlFor="name">Display name</label>
          <input id="name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="tz">Your time zone</label>
          <select id="tz" className="input" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => <option key={z}>{z}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">Used for timestamps you see. Store metrics always use each store&apos;s own time zone.</p>
        </div>
        <button className="btn-primary">Save</button>
      </form>
      <hr className="border-border" />
      <p className="text-sm text-muted">
        Password, email address and sign-in methods are under{" "}
        <Link href="/settings/security" className="underline">
          Security
        </Link>
        .
      </p>
    </section>
  );
}
