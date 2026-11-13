/**
 * Light or dark: which of the app's two palettes (globals.css) a device shows. Dark is the app's
 * own look (the owner's choice, 2026-11-13): what everyone sees until they choose otherwise. The
 * choice is the person's, kept on the device: light, dark, or "system", which follows the
 * device's own setting. What is here is the rules and the script that applies them before the
 * page paints: no React (components/Theme.tsx draws the controls).
 *
 * The palette in use is `data-theme="light|dark"` on <html>. The dark tokens and Tailwind's
 * `dark:` variant both read that attribute, never the device's setting directly.
 */

export type Theme = "light" | "dark";
export type ThemeChoice = Theme | "system";

/** What a device shows with nothing chosen on it. The pages are built with it too (app/layout.tsx). */
export const DEFAULT_THEME: Theme = "dark";
/** localStorage: "light", "dark" or "system" once chosen on this device; nothing saved is DEFAULT_THEME. */
export const THEME_KEY = "theme";
/** Sent on `window` whenever the palette or the choice changes, so every control shows the same. */
export const THEME_EVENT = "insights:theme";
/** The device's own setting. */
export const DEVICE_DARK = "(prefers-color-scheme: dark)";

/** What a device stored, read back: anything but the three choices is the app's own look. */
export const parseThemeChoice = (raw: string | null | undefined): ThemeChoice => (raw === "light" || raw === "dark" || raw === "system" ? raw : DEFAULT_THEME);

/** The palette a choice shows on a device whose own setting is dark, or isn't. */
export const resolveTheme = (choice: ThemeChoice, deviceDark: boolean): Theme => (choice === "system" ? (deviceDark ? "dark" : "light") : choice);

/** What the top bar's button switches to: the other palette from the one showing. */
export const otherTheme = (theme: Theme): Theme => (theme === "dark" ? "light" : "dark");

/**
 * Run in the page before anything is drawn (app/layout.tsx), so a page never flashes the other
 * palette while the app loads. The same rules as parseThemeChoice and resolveTheme, in plain
 * script: blocked storage is "nothing saved" (test/theme.test.mjs holds the two together).
 */
export const THEME_SCRIPT = `(function(){var c=null;try{c=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}var t=c==="light"||c==="dark"?c:c==="system"?(typeof matchMedia==="function"&&matchMedia(${JSON.stringify(DEVICE_DARK)}).matches?"dark":"light"):${JSON.stringify(DEFAULT_THEME)};document.documentElement.setAttribute("data-theme",t)})();`;
