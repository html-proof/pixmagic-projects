"use client";
import { useRouter } from "next/navigation";
import { lazy, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useSmoothScroll } from "@/hooks/useSmoothScroll";
import { GeistMono, GeistSans } from "./shared/fonts";
import { Cursor } from "./shared/Cursor";
import { Navbar } from "./navigation/Navbar";
import { IntroAnimation } from "./intro/IntroAnimation";
import { InsightHero } from "./hero/InsightHero";
import { Deferred, releaseWhenIdle } from "./shared/Deferred";
import { allowGpuParticles } from "./shared/particles";

// Everything below the hero is split into its own chunks. They still render into the static
// HTML (SEO, no layout jump), but their JavaScript doesn't hold up the first screen, and each one
// hydrates only as it nears the viewport or once the page is idle (Deferred).
// React.lazy, not next/dynamic: next/dynamic also writes a <link rel="preload"> for every chunk
// into the HTML, and Chrome warns about each one the page hasn't used a few seconds after load,
// which is exactly what deferring them means. A scene's chunk is fetched when it is released.
const SignalsToDecisions = lazy(() => import("./story/SignalsToDecisions").then((m) => ({ default: m.SignalsToDecisions })));
const BusinessPulse = lazy(() => import("./story/BusinessPulse").then((m) => ({ default: m.BusinessPulse })));
const CustomerJourney = lazy(() => import("./story/CustomerJourney").then((m) => ({ default: m.CustomerJourney })));
const CustomerIntelligence = lazy(() => import("./story/CustomerIntelligence").then((m) => ({ default: m.CustomerIntelligence })));
const ProfitIntelligence = lazy(() => import("./story/ProfitIntelligence").then((m) => ({ default: m.ProfitIntelligence })));
const AskInsight = lazy(() => import("./product/AskInsight").then((m) => ({ default: m.AskInsight })));
const ShopifyConnection = lazy(() => import("./product/ShopifyConnection").then((m) => ({ default: m.ShopifyConnection })));
const ProductReveal = lazy(() => import("./product/ProductReveal").then((m) => ({ default: m.ProductReveal })));
const FinalCTA = lazy(() => import("./conversion/FinalCTA").then((m) => ({ default: m.FinalCTA })));
const Footer = lazy(() => import("./Footer").then((m) => ({ default: m.Footer })));

type Phase = "intro" | "handoff" | "done";

/**
 * Survives client-side navigation but not a reload: coming back to / from /login or /signup
 * inside the app skips the intro, while a fresh visit (and the static HTML) always starts with it.
 */
let introPlayed = false;

type Me = { user: { emailVerified: boolean } | null; workspaces: unknown[]; shared?: unknown };

export function LandingPage() {
  const router = useRouter();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>(() => (introPlayed ? "done" : "intro"));

  // Less motion: no intro at all (CSS already hides it before this runs).
  useEffect(() => {
    if (reduced) setPhase("done");
  }, [reduced]);
  // Hydrate the scenes below the hero in the browser's idle moments from now on (and any of them
  // straight away as it nears the viewport): small pieces between the opening's frames, instead of
  // one long task before the opening could start.
  useEffect(() => releaseWhenIdle(250), []);
  useEffect(() => {
    if (phase === "done") introPlayed = true;
  }, [phase]);
  // Eased wheel scrolling, from the moment the intro gives the page back (it locks scrolling until then).
  useSmoothScroll(!reduced && phase !== "intro");
  // The particle scenes switch to WebGL once the opening has settled: setting a context up stalls
  // the GPU for a moment, which must not land in the intro or the hero's entrance.
  useEffect(() => {
    if (phase !== "done") return;
    const id = window.setTimeout(allowGpuParticles, 1200);
    return () => window.clearTimeout(id);
  }, [phase]);

  // `/` is still where sign-in sends people: a signed-in merchant goes straight on to the app.
  // Anyone else (not signed in, or the API unreachable) stays on the landing page. /auth/whoami
  // answers visitors with `user: null` rather than /me's 401, which browsers log as an error.
  useEffect(() => {
    let cancelled = false;
    api<Me>("/auth/whoami")
      .then((me) => {
        if (!cancelled && me.user) router.replace((me.user.emailVerified || me.shared) && me.workspaces.length ? "/dashboard" : "/onboarding");
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
        <Deferred id="signals">
          <SignalsToDecisions />
        </Deferred>
        <Deferred id="pulse">
          <BusinessPulse />
        </Deferred>
        <Deferred id="journey">
          <CustomerJourney />
        </Deferred>
        <Deferred id="customers">
          <CustomerIntelligence />
        </Deferred>
        <Deferred id="profit">
          <ProfitIntelligence />
        </Deferred>
        <Deferred id="ask">
          <AskInsight />
        </Deferred>
        <Deferred id="connection">
          <ShopifyConnection />
        </Deferred>
        <Deferred id="product">
          <ProductReveal />
        </Deferred>
        <Deferred id="final">
          <FinalCTA />
        </Deferred>
      </main>
      <Deferred id="footer">
        <Footer />
      </Deferred>
    </div>
  );
}
