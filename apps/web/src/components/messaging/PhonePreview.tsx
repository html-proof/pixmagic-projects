"use client";
import { useEffect, useState } from "react";
import { ChevronLeft, Signal, Wifi } from "lucide-react";
import type { SegmentInfo } from "@app/shared/sms";
import { Badge } from "@/components/dashboard/Primitives";
import { countryName, fmtUsd } from "./MessagingUi";

/**
 * Who a text shows as coming from, as far as anyone knows yet:
 *  - name: a sender name (approved, or only asked for: then it says so)
 *  - number: countries that don't show names, or a number the store texts from
 */
export interface PreviewSender {
  kind: "name" | "number";
  label: string;
  /** The SMS provider says it is set up for this store (and registered where that is required). */
  approved: boolean;
}

/**
 * A customer's phone with the text on it: the sender, the message, and under the phone its
 * length in characters and billed SMS parts. A preview, not a promise: carriers and phones decide
 * how the sender is shown.
 */
export function PhonePreview({
  sender,
  text,
  segments,
  worstParts,
  price,
}: {
  sender: PreviewSender;
  text: string;
  segments: SegmentInfo;
  /** Parts with the longest names and links (one customer's long name can add a part). */
  worstParts?: number | null;
  price?: { country: string | null; perPartUsd: number } | null;
}) {
  const initial = sender.kind === "name" ? (sender.label.trim()[0] ?? "?").toUpperCase() : "#";
  const empty = !text.trim();
  // The time now, as a phone shows it (after mount: the server's clock isn't the viewer's).
  const [now, setNow] = useState("9:41");
  useEffect(() => setNow(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date())), []);
  return (
    <figure className="space-y-3" aria-label="Preview of the text on a customer's phone">
      <div className="mx-auto w-full max-w-[290px] rounded-[2.6rem] border-[9px] border-neutral-900 bg-neutral-900 shadow-2xl shadow-black/20 dark:border-neutral-700 dark:bg-neutral-700">
        <div className="overflow-hidden rounded-[2rem] bg-surface">
          {/* Status bar with the notch. */}
          <div className="relative flex items-center justify-between px-6 pb-1 pt-2.5 text-[11px] font-semibold" aria-hidden>
            <span>{now.replace(/\s?[AP]M$/i, "")}</span>
            <span className="absolute left-1/2 top-1.5 h-5 w-20 -translate-x-1/2 rounded-full bg-neutral-900 dark:bg-neutral-700" />
            <span className="flex items-center gap-1">
              <Signal className="h-3 w-3" strokeWidth={2.4} />
              <Wifi className="h-3 w-3" strokeWidth={2.4} />
              <span className="ml-0.5 inline-block h-2.5 w-5 rounded-[3px] border border-current p-[1px]">
                <span className="block h-full w-3/4 rounded-[1px] bg-current" />
              </span>
            </span>
          </div>
          {/* The conversation's header: who it is from. */}
          <div className="flex flex-col items-center gap-1 border-b border-border px-4 pb-2.5 pt-1">
            <div className="flex w-full items-center">
              <ChevronLeft className="h-5 w-5 text-accent" aria-hidden />
              <span className="flex-1" />
            </div>
            <span aria-hidden className="-mt-4 flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-b from-neutral-400 to-neutral-500 text-lg font-semibold text-white">
              {initial}
            </span>
            <span className="max-w-full truncate text-[13px] font-semibold" data-testid="preview-sender">
              {sender.label}
            </span>
          </div>
          {/* The message. */}
          <div className="min-h-[15rem] space-y-2 px-3 py-3">
            <p className="text-center text-[10px] text-muted" aria-hidden>
              Messages
              <br />
              Today {now}
            </p>
            {empty ? (
              <p className="px-2 pt-6 text-center text-xs text-muted">Your message shows here as you write it.</p>
            ) : (
              <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[1.1rem] rounded-bl-[0.35rem] bg-bg px-3 py-2 text-[13px] leading-snug shadow-sm ring-1 ring-border" data-testid="preview-text">
                {text}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-2" aria-hidden>
            <span className="flex-1 rounded-full border border-border px-3 py-1 text-[11px] text-muted">Text Message</span>
          </div>
        </div>
      </div>
      <figcaption className="space-y-1.5 text-center text-xs text-muted">
        <span className="flex flex-wrap items-center justify-center gap-1.5">
          {sender.kind === "name" && !sender.approved ? <Badge tone="warn">Sender name not approved yet</Badge> : null}
          {sender.approved ? <Badge tone="good">Sender approved</Badge> : null}
        </span>
        <span className="block tabular-nums" aria-live="polite">
          {segments.characters} character{segments.characters === 1 ? "" : "s"} · {segments.segments} SMS part{segments.segments === 1 ? "" : "s"}
          {worstParts && worstParts > segments.segments ? ` (up to ${worstParts} with long names or links)` : ""}
        </span>
        <span className="block">
          {segments.encoding === "GSM" ? `Standard characters: up to 160 in one part (153 each when split).` : `Special characters (${segments.nonGsm.slice(0, 4).join(" ")}): up to 70 in one part (67 each when split).`}
        </span>
        {price && price.perPartUsd > 0 ? (
          <span className="block">
            About {fmtUsd(price.perPartUsd * Math.max(1, segments.segments))} per text to {countryName(price.country)} (estimated, US dollars)
          </span>
        ) : null}
        <span className="block">Preview only: how the sender shows depends on each customer&apos;s carrier and phone.</span>
      </figcaption>
    </figure>
  );
}
