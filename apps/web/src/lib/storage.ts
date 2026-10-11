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
