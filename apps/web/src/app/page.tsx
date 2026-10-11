import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "Insights — Shopify Business Intelligence",
  description:
    "Insights turns every order, checkout, customer and payment in your Shopify store into a clear picture of what your business is doing, why, and what to do next.",
  openGraph: {
    title: "Insights — Shopify Business Intelligence",
    description: "Your store is talking. Insights helps you understand what it's saying.",
    type: "website",
  },
};

export const viewport = { themeColor: "#080A0D", colorScheme: "dark" };

/**
 * The public homepage. Signed-out visitors get the landing page; a signed-in merchant who lands
 * here (sign-in flows finish on `/`) is sent on to the dashboard by LandingPage.
 */
export default function Home() {
  return <LandingPage />;
}
