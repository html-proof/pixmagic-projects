"use client";
import type { ReactNode } from "react";
// The Stitch design's typeface, bundled with the app (no font host): globals.css `app-look`.
import "@fontsource-variable/inter";
import { AppProvider } from "@/components/AppContext";
import { AppShell } from "@/components/AppShell";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AppProvider>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
