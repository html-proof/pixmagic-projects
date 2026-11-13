/**
 * localStorage that never throws. It is unavailable in some private modes and when site data is
 * blocked, and everything kept in it is a convenience the app works without: a blocked read is
 * "nothing saved" and a blocked write is dropped.
 */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

export function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

/**
 * The app shell's current workspace, and per workspace its current store. Onboarding and the
 * invitation page set them so the dashboard opens on what was just connected or joined.
 */
export const WORKSPACE_KEY = "ws";
export const storeKey = (workspaceId: string) => `store:${workspaceId}`;

/** Which menu this device shows: "full" once "Show every page" was chosen (lib/menu.ts); nothing saved is the short one. */
export const MENU_LAYOUT_KEY = "menu-layout";
/** The short menu's groups left open on this device, e.g. "store,settings". */
export const MENU_OPEN_KEY = "menu-open";
/** "1" while the sidebar is narrowed to its icons on this device (wide screens). */
export const MENU_RAIL_KEY = "menu-rail";

/** Set once the look around (components/Tour.tsx) was taken or declined on this device, so the Home stops offering it. */
export const TOUR_SEEN_KEY = "tour-seen";

// Light or dark on this device (dark with nothing saved) is kept here too, under THEME_KEY:
// lib/theme.ts owns it, because the script that reads it before the page paints is built there.

/** Per workspace, the newest note (info alert) the bell has shown, so older ones don't light its dot again. */
export const notesSeenKey = (workspaceId: string) => `notes-seen:${workspaceId}`;
