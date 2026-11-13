import type { Metadata } from "next";
import "./globals.css";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { ThemeSync } from "@/components/Theme";
import { THEME_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "bizinsights for Shopify",
  description: "Plain-language store analytics.",
  // Google Search Console ownership tag (account sebanceo@gmail.com), added for the app's earlier
  // address on the old Cloudflare Worker, which Google's OAuth branding verification required then.
  // https://bizinsights.io/ is verified on its own as a Domain property (DNS TXT record). Keep the
  // tag while that earlier verification stands: removing it un-verifies the site.
  verification: { google: "s7xwK411UchDkBKH6KSUy1m8_qG8EQHbw0A2fp2Zuro" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script below puts the chosen palette on <html> (data-theme) before React starts, so the
    // tag differs from what was built: expected, and only this tag is excused.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Light or dark (lib/theme.ts), before anything is drawn: no flash of the other palette. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeSync />
        <ConnectionStatus />
        {children}
      </body>
    </html>
  );
}
