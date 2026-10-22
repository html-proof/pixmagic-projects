"use client";
import { ChevronRight, ShieldAlert, ShieldCheck } from "lucide-react";
import type { SecurityStatus } from "@/lib/accountSecurity";
import { tone } from "./ui";

/** Beside the page's title: all is well, or the one thing to look at first (a click goes to it). */
export function StatusCard({ status, onOpen }: { status: SecurityStatus; onOpen: () => void }) {
  const Glyph = status.tone === "good" ? ShieldCheck : ShieldAlert;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="tone-card group flex w-full min-w-0 items-center gap-4 rounded-xl border px-5 py-4 text-left shadow-[var(--shadow)] transition hover:brightness-[1.03] sm:w-auto sm:min-w-[22rem]"
      style={tone(status.tone)}
    >
      <span className="tone-icon size-11" aria-hidden>
        <Glyph size={24} strokeWidth={1.9} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{status.title}</span>
        <span className="block text-sm text-muted">{status.detail}</span>
      </span>
      <ChevronRight size={18} aria-hidden className="shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
