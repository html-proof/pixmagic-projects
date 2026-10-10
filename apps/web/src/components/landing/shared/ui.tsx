"use client";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { riseIn } from "@/lib/motion";

/** The only two destinations the landing page sends anyone to. */
export const ROUTES = { signup: "/signup", login: "/login" } as const;

/**
 * Primary call to action. Every one on the page goes to /signup; the arrow slides on hover.
 * `size="lg"` for scene CTAs, default for the nav.
 */
export function SignupButton({ children = "Sign up", size = "md", className = "" }: { children?: ReactNode; size?: "md" | "lg"; className?: string }) {
  const pad = size === "lg" ? "h-14 px-7 text-[16px]" : "h-10 px-4 text-[14px]";
  return (
    <Link href={ROUTES.signup} className={`lp-btn-primary lp-focus group ${pad} ${className}`} data-cursor="OPEN">
      <span>{children}</span>
      <ArrowRight aria-hidden className="size-4 transition-transform duration-300 ease-lp group-hover:translate-x-1" strokeWidth={2.2} />
    </Link>
  );
}

/** "Already have an account? Log in" line under a scene CTA. */
export function LoginPrompt({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[15px] text-lp-muted ${className}`}>
      Already have an account?{" "}
      <Link href={ROUTES.login} className="lp-focus rounded font-medium text-lp-text underline decoration-lp-line-strong underline-offset-4 transition-colors hover:decoration-lp-violet-bright">
        Log in
      </Link>
    </p>
  );
}

/**
 * Standard scene opener: mono eyebrow, big headline, supporting copy, each rising in once.
 * Headlines are h2; the hero owns the page's only h1.
 */
export function SectionIntro({
  eyebrow,
  title,
  lead,
  align = "left",
  className = "",
  id,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  align?: "left" | "center";
  className?: string;
  /** id for the h2, so the section can be `aria-labelledby` it. */
  id?: string;
}) {
  const center = align === "center";
  return (
    <div className={`${center ? "mx-auto text-center" : ""} max-w-4xl ${className}`}>
      {eyebrow && (
        <motion.p {...riseIn(0, 12)} className="lp-eyebrow mb-5">
          {eyebrow}
        </motion.p>
      )}
      <motion.h2 {...riseIn(0.05)} id={id} className="lp-heading text-balance">
        {title}
      </motion.h2>
      {lead && (
        <motion.p {...riseIn(0.15)} className={`lp-lead mt-6 max-w-2xl text-pretty ${center ? "mx-auto" : ""}`}>
          {lead}
        </motion.p>
      )}
    </div>
  );
}

/** Small honest caption for visuals that demonstrate structure rather than real data. */
export function IllustrativeNote({ children = "Illustrative", className = "" }: { children?: ReactNode; className?: string }) {
  return (
    <span className={`lp-eyebrow inline-flex items-center gap-2 rounded-full border border-lp-line px-3 py-1 text-[10.5px] ${className}`}>
      <span aria-hidden className="size-1.5 rounded-full bg-lp-violet" />
      {children}
    </span>
  );
}

/** Visually hidden text for screen readers (conceptual visuals describe themselves with this). */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
