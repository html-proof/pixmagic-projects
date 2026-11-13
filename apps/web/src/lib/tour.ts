/**
 * The look around (components/Tour.tsx): a short, optional walk through the signed-in frame for
 * someone new. It is offered, never started by itself, and can be left at any step. What is here
 * is its steps, how it is started from anywhere on the page, and where its card goes: no React.
 */

export interface TourStep {
  id: string;
  /**
   * `data-tour` names to point at, the first one on screen wins (the sidebar on a wide screen, the
   * menu button on a phone). A step with none of them on the page is left out.
   */
  targets: string[];
  title: string;
  body: string;
}

export const TOUR_STEPS: TourStep[] = [
  {
    id: "numbers",
    targets: ["numbers"],
    title: "Your numbers at a glance",
    body: "Four figures for the dates you picked, each with its change. Click one for the detail behind it.",
  },
  {
    id: "dates",
    targets: ["dates"],
    title: "Choose the dates",
    body: "Pick today, a week, a month or your own dates. Every figure on the page follows.",
  },
  {
    id: "menu",
    targets: ["menu", "menu-button"],
    title: "Everything else is in the menu",
    body: "The pages you'll use most are listed. The rest sit in groups that open with a click, and \"Show every page\" lists them all.",
  },
  {
    id: "search",
    targets: ["search", "search-button"],
    title: "Or just search",
    body: "Type the name of any page or setting to jump straight to it.",
  },
  {
    id: "bell",
    targets: ["bell"],
    title: "We tell you when something breaks",
    body: "A dot here means a connection or a sync needs a look. Each note opens the page that fixes it.",
  },
  {
    id: "help",
    targets: ["help"],
    title: "Help is always here",
    body: "Email us or read the help centre from this button. You can also take this look around again from it.",
  },
];

/** Asked from anywhere on a signed-in page (the Home's offer, the help button); the shell listens. */
export const TOUR_EVENT = "insights:tour";
export const startTour = (): void => {
  window.dispatchEvent(new Event(TOUR_EVENT));
};

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Where the tour's card goes for a highlighted `target`: under it, else over it, else beside it
 * (the sidebar fills the window's height), else across the bottom of the window. Always wholly on
 * screen, `margin` from every edge.
 */
export function placeCard(target: Box, card: { width: number; height: number }, view: { width: number; height: number }, gap = 12, margin = 12): { top: number; left: number } {
  const clamp = (v: number, max: number) => Math.max(margin, Math.min(v, max));
  const x = (v: number) => clamp(v, view.width - card.width - margin);
  const y = (v: number) => clamp(v, view.height - card.height - margin);
  const bottom = target.top + target.height;
  const right = target.left + target.width;
  if (bottom + gap + card.height <= view.height - margin) return { top: bottom + gap, left: x(target.left) };
  if (target.top - gap - card.height >= margin) return { top: target.top - gap - card.height, left: x(target.left) };
  if (right + gap + card.width <= view.width - margin) return { top: y(target.top), left: right + gap };
  if (target.left - gap - card.width >= margin) return { top: y(target.top), left: target.left - gap - card.width };
  return { top: y(view.height), left: x((view.width - card.width) / 2) };
}
