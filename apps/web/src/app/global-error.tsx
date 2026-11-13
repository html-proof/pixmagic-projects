"use client";
import "./globals.css";
import { ErrorState } from "@/components/ErrorState";
import { ThemeSync } from "@/components/Theme";
import { DEFAULT_THEME } from "@/lib/theme";

/**
 * Last-resort recovery when even the root layout fails. It replaces that layout, so it brings the
 * site's styles itself, and puts the chosen palette (light or dark) back on its own <html>.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning><body className="min-h-screen antialiased"><ThemeSync /><ErrorState kind="server" onRetry={retry} correlationId={error.digest} fullPage /></body></html>;
}
