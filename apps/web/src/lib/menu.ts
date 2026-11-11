/**
 * The short menu (lib/features.ts SIMPLE_MENU): the sidebar lists the everyday pages, and the rest
 * sit in groups that fold. Every page keeps its name and its address; nothing is moved or removed.
 * The rules are here, apart from the drawing (components/AppShell.tsx), so they can be tested.
 */

/** The groups that fold, in the order the sidebar lists them. */
export const MENU_GROUPS = ["reports", "store", "marketing", "settings"] as const;
export type MenuGroupId = (typeof MENU_GROUPS)[number];

/** Which menu a device shows: the short one unless "Show every page" was chosen there. */
export type MenuLayout = "short" | "full";

/**
 * A menu this short has nothing worth folding: a member shown a handful of pages (Team & Access),
 * or a shared dashboard, gets the plain list.
 */
export const FOLD_FROM = 10;

/** Whether the menu folds: the short layout, and enough entries for folding to save reading. */
export const folds = (layout: MenuLayout, entries: number): boolean => layout === "short" && entries >= FOLD_FROM;

/** A group folds only when it holds more than one page: one page is shown as it is. */
export const groupFolds = (items: number): boolean => items > 1;

/** The groups left open on this device, as stored ("store,settings"); anything unknown is dropped. */
export function parseOpenGroups(raw: string | null): MenuGroupId[] {
  if (!raw) return [];
  const known = new Set<string>(MENU_GROUPS);
  return [...new Set(raw.split(",").filter((g) => known.has(g)))] as MenuGroupId[];
}

/** Open or close a group; the answer is what to store. */
export function toggleGroup(open: readonly MenuGroupId[], id: MenuGroupId): MenuGroupId[] {
  return open.includes(id) ? open.filter((g) => g !== id) : [...open, id];
}

/**
 * Whether a group shows its pages. One holding the page being looked at is open by itself, so the
 * current page is never hidden in its own menu, until it is closed by hand (`closedHere`, forgotten
 * on the next page). Any other is open when it was opened on this device.
 */
export const groupOpen = (id: MenuGroupId, open: readonly MenuGroupId[], holdsCurrent: boolean, closedHere: readonly MenuGroupId[] = []): boolean =>
  holdsCurrent ? !closedHere.includes(id) : open.includes(id);
