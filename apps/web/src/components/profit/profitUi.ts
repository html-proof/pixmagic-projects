import { outcomeOf } from "@app/shared/profit";
import type { Tone } from "@/components/dashboard/Primitives";

// ---------------------------------------------------------------------------
// Small pieces the Profit & Loss page's sections share.
// ---------------------------------------------------------------------------

/** An ad platform by name, for its spend's row. */
export const PLATFORM_NAME: Record<string, string> = { meta: "Meta", google: "Google" };

/** A profit's tone: good above 0, danger below, none at 0 or when not known. */
export const toneOf = (n: number | null | undefined): Tone | undefined => {
  const o = outcomeOf(n);
  return o === "profit" ? "good" : o === "loss" ? "danger" : undefined;
};

export const TONE_TEXT: Partial<Record<Tone, string>> = { good: "text-good", danger: "text-danger" };

/** Cents added up, null when any isn't known. */
export const sumOf = (...xs: Array<number | null | undefined>) => (xs.some((x) => x === null || x === undefined) ? null : xs.reduce<number>((a, x) => a + Math.round(x! * 100), 0) / 100);
