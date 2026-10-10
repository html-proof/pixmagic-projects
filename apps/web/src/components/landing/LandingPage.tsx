"use client";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { GeistMono, GeistSans } from "./shared/fonts";
import { Cursor } from "./shared/Cursor";
import { Navbar } from "./navigation/Navbar";
import { IntroAnimation } from "./intro/IntroAnimation";
import { InsightHero } from "./hero/InsightHero";

// Everything below the hero is split into its own chunks. They still render into the static
// HTML (SEO, no layout jump), but their JavaScript doesn't hold up the first screen.
const SignalsToDecisions = dynamic(() => import("./story/SignalsToDecisions").then((m) => m.SignalsToDecisions));
const BusinessPulse = dynamic(() => import("./story/BusinessPulse").then((m) => m.BusinessPulse));
const CustomerJourney = dynamic(() => import("./story/CustomerJourney").then((m) => m.CustomerJourney));
const CustomerIntelligence = dynamic(() => import("./story/CustomerIntelligence").then((m) => m.CustomerIntelligence));
const ProfitIntelligence = dynamic(() => import("./story/ProfitIntelligence").then((m) => m.ProfitIntelligence));
const AskInsight = dynamic(() => import("./product/AskInsight").then((m) => m.AskInsight));
const ShopifyConnection = dynamic(() => import("./product/ShopifyConnection").then((m) => m.ShopifyConnection));
const ProductReveal = dynamic(() => import("./product/ProductReveal").then((m) => m.ProductReveal));
const FinalCTA = dynamic(() => import("./conversion/FinalCTA").then((m) => m.FinalCTA));
const Footer = dynamic(() => import("./Footer").then((m) => m.Footer));

type Phase = "intro" | "handoff" | "done";

/**
 * Survives client-side navigation but not a reload: coming back to / from /login or /signup
 * inside the app skips the intro, while a fresh visit (and the static HTML) always starts with it.
 */
let introPlayed = false;

type Me = { user: { emailVerified: boolean }; workspaces: unknown[] };

export function LandingPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(() => (introPlayed ? "done" : "intro"));

  // Less motion: no intro at all (CSS already hides it before this runs).
  useEffect(() => {
    if (reduced) setPhase("done");
  }, [reduced]);
  useEffect(() => {
    if (phase === "done") introPlayed = true;
  }, [phase]);

  // `/` is still where sign-in sends people: a signed-in merchant goes straight on to the app.
  // Anyone else (not signed in, or the API unreachable) stays on the landing page.
  useEffect(() => {
    let cancelled = false;
    api<Me>("/me")
      .then((me) => {
        if (!cancelled) router.replace(me.user.emailVerified && me.workspaces.length ? "/dashboard" : "/onboarding");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className={`lp-root ${GeistSans.variable} ${GeistMono.variable} min-h-svh`}>
      <a
        href="#main"
        className="lp-focus sr-only z-[200] rounded-lg bg-lp-surface px-4 py-2 text-sm text-lp-text focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <Cursor />
      <Navbar revealed={phase !== "intro"} brandVisible={phase === "done"} />
      {phase !== "done" && <IntroAnimation onHandoff={() => setPhase("handoff")} onDone={() => setPhase("done")} />}
      <main id="main">
        <InsightHero ready={phase !== "intro"} />
        <SignalsToDecisions />
        <BusinessPulse />
        <CustomerJourney />
        <CustomerIntelligence />
        <ProfitIntelligence />
        <AskInsight />
        <ShopifyConnection />
        <ProductReveal />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
