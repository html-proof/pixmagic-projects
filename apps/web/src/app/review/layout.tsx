import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Review your order",
  description: "Tell the store how your order went.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ReviewLayout({ children }: { children: ReactNode }) {
  return children;
}
