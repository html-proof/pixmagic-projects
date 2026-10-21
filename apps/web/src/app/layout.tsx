import type { Metadata } from "next";
import "./globals.css";
// Next includes the root not-found boundary in every route's Flight data and preloads its CSS.
// Apply the same scoped module from the layout so that preload is consumed on every route.
import "./not-found.module.css";
import { ConnectionStatus } from "@/components/ConnectionStatus";

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
    <html lang="en">
      <body className="min-h-screen antialiased"><ConnectionStatus />{children}</body>
    </html>
  );
}
