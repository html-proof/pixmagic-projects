"use client";
import { AccountSecurity } from "@/components/auth/AccountSecurity";

export default function SecurityPage() {
  return (
    <>
      <section className="card">
        <h1 className="text-lg font-semibold">Security</h1>
        <p className="mt-1 text-sm text-muted">Your email address, password, how you sign in, and where you&apos;re signed in.</p>
      </section>
      <AccountSecurity />
    </>
  );
}
