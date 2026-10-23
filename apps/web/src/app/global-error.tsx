"use client";
import "./globals.css";
import { ErrorState } from "@/components/ErrorState";

/** Last-resort recovery when even the root layout fails. It replaces that layout, so it brings the site's styles itself. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <html lang="en"><body className="min-h-screen antialiased"><ErrorState kind="server" onRetry={retry} correlationId={error.digest} fullPage /></body></html>;
}
