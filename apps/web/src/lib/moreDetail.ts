/**
 * "More detail" (components/MoreDetail.tsx, lib/features.ts FOLD_DETAIL): a page shows its few
 * numbers first and keeps its other panels in one fold that says what is inside. Nothing is removed:
 * a click opens it, and the device remembers. The rules are here, apart from the drawing, so they
 * can be tested.
 */

/** What a device chose for a fold; nothing saved is `null`. */
export type DetailChoice = "open" | "closed";

/** Where a device keeps its choice, one per fold ("more-detail:sales"). */
export const detailKey = (id: string): string => `more-detail:${id}`;

/** The stored choice; anything unknown is nothing saved. */
export const parseDetail = (raw: string | null): DetailChoice | null => (raw === "open" || raw === "closed" ? raw : null);

/**
 * Whether the fold shows its panels: always while folding is off or the page is being printed (a
 * printout has every panel, as it always had); otherwise only once this device opened it.
 */
export const detailOpen = (folds: boolean, choice: DetailChoice | null, printing = false): boolean => !folds || printing || choice === "open";

/**
 * What is inside, in words, so a closed fold is not a mystery: the first few panels by name and how
 * many more there are ("Total sales line by line, the check against Shopify and 4 more").
 */
export function detailSummary(names: readonly string[], shown = 2): string {
  const all = names.filter((n) => n.trim() !== "");
  if (all.length === 0) return "";
  if (all.length === 1) return all[0]!;
  // Naming one more is shorter than "and 1 more".
  const take = all.length - shown === 1 ? all.length : Math.min(shown, all.length);
  const head = all.slice(0, take);
  const rest = all.length - head.length;
  if (rest > 0) return `${head.join(", ")} and ${rest} more`;
  return `${head.slice(0, -1).join(", ")} and ${head[head.length - 1]}`;
}
