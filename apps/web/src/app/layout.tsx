import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Insights for Shopify",
  description: "Plain-language store analytics.",
  // Google Search Console ownership of https://insights.imeseban.workers.dev/ (account sebanceo@gmail.com), which
  // Google's OAuth branding verification requires. Keep it: removing it un-verifies the site.
  verification: { google: "s7xwK411UchDkBKH6KSUy1m8_qG8EQHbw0A2fp2Zuro" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
