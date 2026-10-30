"use client";
import { AccountSecurity } from "@/components/auth/AccountSecurity";

export default function SecurityPage() {
  // The settings menu's name for it (lib/settingsNav.ts).
  return <AccountSecurity title="Sign-in & security" />;
}
