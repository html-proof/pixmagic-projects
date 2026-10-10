import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Track your order",
  description: "Your order's status, shipping and delivery.",
  // The page is reached through a private link: never indexed, never sent on as a referrer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function TrackLayout({ children }: { children: ReactNode }) {
  return children;
}
