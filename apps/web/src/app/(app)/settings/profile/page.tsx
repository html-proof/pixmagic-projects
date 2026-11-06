"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Settings → Profile, as the Stitch design's Your account screen draws its first card (prototype
// v2, screen 34): "Details", its title on the soft band, with your name, time zone and email.
// Changing the email or the password, two-step sign-in, devices and recent sign-ins are the same
// screen's second part, Settings → Security (components/auth/AccountSecurity.tsx).
// ---------------------------------------------------------------------------

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
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Profile</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">Your own account: the same in every workspace you belong to.</p>
      </header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <section aria-labelledby="details-h" className="home-card animate-rise overflow-hidden">
        <h2 id="details-h" className="home-h2 bg-home-soft px-5 py-4 sm:px-6">
          Details
        </h2>
        <form onSubmit={save} className="space-y-5 p-5 sm:p-6">
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
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-home-line pt-5">
            <div className="min-w-0">
              <p className="label">Email</p>
              <p className="text-sm break-all">
                {me.user.email} {me.user.emailVerified && <span className="text-good">· verified</span>}
              </p>
              <p className="text-xs text-muted">Changing it sends a code to the new address first.</p>
            </div>
            <Link href="/settings/security" className="home-btn">
              Change<span className="sr-only"> your email on Security</span>
            </Link>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-home-line pt-5">
            <div className="min-w-0">
              <p className="label">Password and sign-in</p>
              <p className="text-sm text-muted">Password, email address and sign-in methods are under Security, with two-step sign-in and your devices.</p>
            </div>
            <Link href="/settings/security" className="home-btn">
              Open Security
            </Link>
          </div>
          <button className="btn-primary">
            <Check aria-hidden className="h-4 w-4" />
            Save
          </button>
        </form>
      </section>
    </div>
  );
}
