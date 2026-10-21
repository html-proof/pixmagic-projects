import type { Metadata } from "next";
import "./globals.css";
import { ConnectionStatus } from "@/components/ConnectionStatus";

export const metadata: Metadata = {
  title: "Insights for Shopify",
  description: "Plain-language store analytics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased"><ConnectionStatus />{children}</body>
    </html>
  );
}
