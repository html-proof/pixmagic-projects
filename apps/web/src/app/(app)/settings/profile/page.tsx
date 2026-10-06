"use client";
import { useState, type FormEvent } from "react";
import { sendPasswordResetEmail } from "firebase/auth";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api } from "@/lib/api";
import { firebaseAuth } from "@/lib/firebase";

export default function ProfilePage() {
  const { me, reloadMe } = useApp();
  const [name, setName] = useState(me.user.displayName ?? "");
  const [tz, setTz] = useState(me.user.timezone);
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [tz];

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
          <label className="label">Email</label>
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
      <button
        className="btn-secondary"
        onClick={() =>
          sendPasswordResetEmail(firebaseAuth(), me.user.email)
            .then(() => setMsg({ kind: "info", text: "We emailed you a link to set a new password." }))
            .catch(() => setMsg({ kind: "error", text: "Couldn't send the email right now." }))
        }
      >
        Change password
      </button>
    </section>
  );
}
