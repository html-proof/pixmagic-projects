"use client";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { readLocal, writeLocal } from "@/lib/storage";
import { DEFAULT_THEME, DEVICE_DARK, otherTheme, parseThemeChoice, resolveTheme, THEME_EVENT, THEME_KEY, type Theme, type ThemeChoice } from "@/lib/theme";

// ---------------------------------------------------------------------------
// Light or dark (rules in lib/theme.ts): the choice kept on this device, the palette it shows, and
// the two controls that change it: the sun-or-moon button in the top bar and the Appearance card
// on Settings → Profile. Dark until someone chooses otherwise. The page's first paint is the inline
// script's (app/layout.tsx); from then on this file keeps <html data-theme> right.
// ---------------------------------------------------------------------------

/** This tab's copy of the choice: read from the device once, so a choice still holds for the visit where storage is blocked. */
let chosen: ThemeChoice | null = null;
const choiceNow = (): ThemeChoice => (chosen ??= parseThemeChoice(readLocal(THEME_KEY)));
const themeNow = (): Theme => resolveTheme(choiceNow(), window.matchMedia(DEVICE_DARK).matches);

/** Put the palette on the page and tell every control. */
function apply(): void {
  document.documentElement.setAttribute("data-theme", themeNow());
  window.dispatchEvent(new Event(THEME_EVENT));
}

function setThemeChoice(choice: ThemeChoice): void {
  chosen = choice;
  writeLocal(THEME_KEY, choice);
  apply();
}

const subscribe = (onChange: () => void) => {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
};

/** The choice on this device, the palette showing, and how to change it. Before the page is in a browser: the app's own look. */
export function useTheme(): { choice: ThemeChoice; theme: Theme; setChoice: (choice: ThemeChoice) => void } {
  const choice = useSyncExternalStore<ThemeChoice>(subscribe, choiceNow, () => DEFAULT_THEME);
  const theme = useSyncExternalStore<Theme>(subscribe, themeNow, () => DEFAULT_THEME);
  return { choice, theme, setChoice: setThemeChoice };
}

/**
 * On every page (app/layout.tsx), drawing nothing: while the choice is "same as device" the page
 * follows the device as its setting changes (at sunset, say), and a choice made in another tab
 * reaches this one.
 */
export function ThemeSync() {
  // Before the paint: in development React's strict mode resets <html> to what was built, dropping
  // the attribute the script set, and this puts it back unseen. Nothing to do in production.
  useLayoutEffect(() => {
    const device = window.matchMedia(DEVICE_DARK);
    const onStorage = (e: StorageEvent) => {
      // `key` is null when the site's storage was cleared.
      if (e.key !== THEME_KEY && e.key !== null) return;
      chosen = null;
      apply();
    };
    apply();
    device.addEventListener("change", apply);
    window.addEventListener("storage", onStorage);
    return () => {
      device.removeEventListener("change", apply);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return null;
}

/** The top bar's button: one click to the other palette. It shows where the click goes (a moon while the page is light). */
export function ThemeToggle() {
  const { theme, setChoice } = useTheme();
  const next = otherTheme(theme);
  const label = `Switch to ${next} mode`;
  const Icon = next === "dark" ? Moon : Sun;
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className="flex h-10 w-10 items-center justify-center rounded-full text-muted transition-colors hover:bg-text/[0.05] hover:text-text"
    >
      <Icon aria-hidden className="h-5 w-5" strokeWidth={1.8} />
    </button>
  );
}

const CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string; hint: string; icon: LucideIcon }> = [
  { value: "dark", label: "Dark", hint: "A dark page with light text.", icon: Moon },
  { value: "light", label: "Light", hint: "A bright page with dark text.", icon: Sun },
  { value: "system", label: "Same as device", hint: "Follows this device's own setting.", icon: Monitor },
];

/** Settings → Profile's Appearance card: the three choices, the one in use marked. Dark, the app's own look, comes first. */
export function AppearanceCard() {
  const { choice, setChoice } = useTheme();
  return (
    <section aria-labelledby="appearance-h" className="home-card animate-rise overflow-hidden">
      <h2 id="appearance-h" className="home-h2 bg-home-soft px-5 py-4 sm:px-6">
        Appearance
      </h2>
      <div className="p-5 sm:p-6">
        <fieldset>
          <legend className="label">Light or dark mode</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {CHOICES.map((c) => {
              const on = c.value === choice;
              return (
                <label
                  key={c.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${
                    on ? "border-accent bg-accent/[0.08]" : "border-border hover:bg-home-soft"
                  }`}
                >
                  <input type="radio" name="theme" value={c.value} checked={on} onChange={() => setChoice(c.value)} className="sr-only" />
                  <c.icon aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 ${on ? "text-accent" : "text-muted"}`} strokeWidth={1.8} />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{c.label}</span>
                    <span className="block text-xs text-muted">{c.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <p className="mt-3 text-xs text-muted">Dark unless you choose otherwise. Kept on this device and browser. The sun or moon button at the top of every page switches it too.</p>
      </div>
    </section>
  );
}
