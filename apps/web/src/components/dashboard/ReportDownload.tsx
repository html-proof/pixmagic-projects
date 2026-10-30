"use client";
import { useState } from "react";
import { Download } from "lucide-react";
import { useApp } from "@/components/AppContext";
import { actionError, ApiError } from "@/lib/api";

/**
 * "Download CSV" for a report on screen, for whoever may export reports ("Export approved reports";
 * the API checks it too): runs `download` (a saveApiFile), and says beside it why one didn't work
 * (`messages`: the page's own words for an API code).
 */
export function CsvButton({
  download,
  testid,
  label = "Download CSV",
  disabled = false,
  messages = {},
  tall = false,
}: {
  download: () => Promise<void>;
  testid: string;
  label?: string;
  disabled?: boolean;
  messages?: Readonly<Record<string, string>>;
  /** As tall as a header's controls (h-9) rather than a panel's (h-8). */
  tall?: boolean;
}) {
  const { allowed } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!allowed("reports.export")) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download();
    } catch (e) {
      if (e instanceof ApiError && Object.hasOwn(messages, e.code)) setError(messages[e.code]!);
      else if (e instanceof ApiError && e.status === 429) setError("Too many downloads. Wait a few minutes and try again.");
      else setError(actionError(e, "download the report"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2 print:hidden">
      <button type="button" className={`btn-secondary ${tall ? "h-9" : "h-8"} gap-2 px-3 text-sm`} onClick={() => void run()} disabled={busy || disabled} aria-busy={busy} data-testid={testid}>
        <Download aria-hidden className="h-4 w-4" />
        {busy ? "Preparing…" : label}
      </button>
      {error && (
        <span className="text-xs text-danger" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
