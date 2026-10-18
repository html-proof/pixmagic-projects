"use client";
import { ArrowUp, ChartColumn, Check, FileText, LayoutDashboard, Package, Settings, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandLogo, BrandMark } from "@/components/Brand";

/**
 * What the showcase says, one message at a time (each headline is exactly two lines). Only what the
 * App Store listing offers (shopify-app/listing/listing-copy.md, "What must not be claimed"): no
 * live updates, conversion, ads or email.
 */
const SLIDES: Array<{ headline: [string, string]; body: string }> = [
  {
    headline: ["Turn your data", "into decisions"],
    body: "Track sales, orders, top products and stock, and see which areas of your store need attention first.",
  },
  {
    headline: ["Every number,", "in plain words"],
    body: "Total sales, orders, products and stock side by side, explained so anyone can act on them.",
  },
  {
    headline: ["Compare any dates", "at a glance"],
    body: "See each number next to the period before or the dates you pick, with the change worked out for you.",
  },
];

const FEATURES = ["Sales, orders and stock", "Plain-language reports", "Read-only Shopify access", "Access anywhere"];

/** Time on each message while it advances on its own. */
const SLIDE_MS = 7000;

/**
 * The left half of the split auth pages (wide screens only): brand, a short pitch that advances every few
 * seconds, and an illustration of the dashboard. It stops advancing while the pointer or focus
 * is on it, for good once someone picks a message, and never for people who ask for less motion.
 */
export function AuthShowcase() {
  const [slide, setSlide] = useState(0);
  const [held, setHeld] = useState(false);
  const [picked, setPicked] = useState(false);

  useEffect(() => {
    if (held || picked || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setInterval(() => setSlide((s) => (s + 1) % SLIDES.length), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [held, picked]);

  return (
    <aside
      aria-label="About bizinsights"
      className="auth-showcase relative isolate hidden flex-col overflow-hidden px-11 pt-10 pb-8 lg:flex xl:px-14"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <Backdrop />
      <BrandLogo className="text-[19px] text-white" />

      <div className="mt-[clamp(1.5rem,4vh,3rem)] grid">
        {SLIDES.map((s, i) => (
          <div
            key={i}
            aria-hidden={i !== slide}
            className={`[grid-area:1/1] transition-[opacity,transform,visibility] duration-500 ease-out ${i === slide ? "visible opacity-100" : "invisible translate-y-2 opacity-0"}`}
          >
            <p className="text-[clamp(2.125rem,3.4vw,2.875rem)] leading-[1.08] font-bold tracking-[-0.02em]">
              {s.headline[0]}
              <br />
              {s.headline[1]}
            </p>
            <p className="mt-4 max-w-[30rem] text-[17px] leading-relaxed text-white/75">{s.body}</p>
          </div>
        ))}
      </div>

      <ul className="relative mt-6 space-y-3">
        {FEATURES.map((f) => (
          <li key={f} className="flex items-center gap-3 text-base text-white/90">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[#3fcf8a] text-[#06301c] shadow-[0_4px_12px_-4px_rgb(63_207_138/0.7)]">
              <Check size={15} strokeWidth={3} aria-hidden />
            </span>
            {f}
          </li>
        ))}
      </ul>

      <DashboardPreview />

      <footer className="relative mt-6 flex items-center justify-between gap-4 text-sm text-white/65">
        <p>Plain-language analytics for Shopify stores.</p>
        <div className="flex items-center gap-1" role="group" aria-label="Messages">
          {SLIDES.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Message ${i + 1} of ${SLIDES.length}`}
              aria-current={i === slide ? "true" : undefined}
              onClick={() => {
                setPicked(true);
                setSlide(i);
              }}
              className="group grid size-6 place-items-center rounded-full focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
            >
              <span
                className={`block h-2 rounded-full transition-all duration-300 ${i === slide ? "w-5 bg-[#7be3a8]" : "w-2 bg-white/30 group-hover:bg-white/55"}`}
              />
            </button>
          ))}
        </div>
      </footer>
    </aside>
  );
}

/** Soft green hills and a glow behind everything. Decoration only. */
function Backdrop() {
  return (
    <svg aria-hidden="true" focusable="false" className="pointer-events-none absolute inset-0 -z-10 size-full" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="auth-hill" x1="1" y1="0" x2="0.35" y2="0.85">
          <stop offset="0%" stopColor="#4fd08f" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#23885a" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#0d3a27" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="auth-band" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#38b878" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#164e35" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="auth-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#3fcf8a" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#3fcf8a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="470" cy="470" r="250" fill="#ffffff" fillOpacity="0.025" />
      <circle cx="560" cy="380" r="180" fill="#ffffff" fillOpacity="0.025" />
      <path d="M600 150C548 252 486 380 380 476C300 548 250 600 214 800H600Z" fill="url(#auth-hill)" />
      <path d="M0 560C70 548 150 590 228 700L240 800H0Z" fill="url(#auth-band)" />
      <ellipse cx="360" cy="600" rx="260" ry="160" fill="url(#auth-glow)" />
    </svg>
  );
}

const NAV = [
  { label: "Dashboard", Icon: LayoutDashboard },
  { label: "Analytics", Icon: ChartColumn },
  { label: "Reports", Icon: FileText },
  { label: "Customers", Icon: Users },
  { label: "Products", Icon: Package },
  { label: "Settings", Icon: Settings },
];

const STATS = [
  { label: "Orders", value: "1,428", change: "8%" },
  { label: "Products sold", value: "3,912", change: "11%" },
  { label: "Avg. order", value: "$87.10", change: "4%" },
];

/**
 * A tilted, illustrative dashboard: made-up numbers, labelled as such, and hidden from assistive
 * technology.
 */
function DashboardPreview() {
  return (
    // Anchored to the bottom so the tilted card's raised right side can rise beside the list above.
    <div aria-hidden="true" className="relative mt-4 min-h-[284px] flex-1">
      <p className="absolute top-0 left-0 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/75 ring-1 ring-white/15" data-testid="showcase-illustration">
        Illustration with sample figures
      </p>
      {/* The entrance animation and the tilt are on separate elements: an animation's transform replaces an inline one. */}
      <div className="absolute bottom-0 left-0 w-[calc(100%+2.5rem)] max-w-[620px] animate-rise [--i:2]">
        <div
          className="flex origin-bottom-left gap-3 rounded-[22px] border border-white/10 bg-[#0e3a29]/85 p-3 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.7)]"
          style={{ transform: "perspective(1600px) rotateX(14deg) rotateY(-16deg) rotateZ(-6deg)" }}
        >
          <div className="auth-glass hidden w-[128px] shrink-0 flex-col gap-1 p-3 text-[11px] text-white/65 xl:flex">
            <span className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-white">
              <BrandMark size={18} />
              bizinsights
            </span>
            {NAV.map(({ label, Icon }, i) => (
              <span key={label} className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${i === 0 ? "bg-[#2f9b66] text-white" : ""}`}>
                <Icon size={12} />
                {label}
              </span>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="auth-glass relative px-4 pt-3.5 pb-2">
              <p className="text-[12px] text-white/70">Total sales</p>
              <p className="mt-1 flex items-baseline gap-2 text-[26px] font-semibold tracking-tight">
                $124,380 <span className="text-[12px] font-medium text-[#7be3a8]">+ 12%</span>
              </p>
              <RevenueLine />
              <span className="absolute -top-3.5 right-5 flex items-center gap-1 rounded-lg bg-[#24855a] px-2.5 py-1.5 text-[15px] font-semibold text-white shadow-[0_10px_24px_-8px_rgb(0_0_0/0.6)] ring-1 ring-white/15">
                <ArrowUp size={15} strokeWidth={2.75} />
                +12%
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {STATS.map((s) => (
                <div key={s.label} className="auth-glass px-3 py-2.5">
                  <p className="text-[11px] text-white/70">{s.label}</p>
                  <p className="mt-0.5 text-[19px] font-semibold tracking-tight">{s.value}</p>
                  <p className="text-[11px] text-[#7be3a8]">+ {s.change}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const LINE =
  "M0 70C14 70 20 54 34 56S52 76 68 72S88 48 104 50S124 70 140 64S160 36 176 40S196 58 212 50S232 26 248 28S270 34 284 20S296 8 300 6";

function RevenueLine() {
  return (
    <svg viewBox="0 0 300 84" className="mt-1 h-[64px] w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="auth-rev-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4fd08f" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#4fd08f" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${LINE}V84H0Z`} fill="url(#auth-rev-fill)" />
      <path d={LINE} fill="none" stroke="#5ee39a" strokeWidth="2.5" strokeLinecap="round" pathLength={1} className="animate-draw" />
    </svg>
  );
}
