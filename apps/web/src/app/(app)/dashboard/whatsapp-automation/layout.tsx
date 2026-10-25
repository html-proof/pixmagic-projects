"use client";
import type { ReactNode } from "react";
import { ToastProvider } from "@/components/AppUi";

export default function WhatsappAutomationLayout({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
