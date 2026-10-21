/**
 * Shopify's Shopping Bag, as published on shopify.com/brand-assets ("Download The Shopping Bag").
 * The paths and colours are Shopify's files copied unchanged: never redraw, recolour, outline,
 * shadow or stretch them (brand rules, and App Store requirement 4.4.3). Decorative: the text
 * beside it carries the accessible name.
 *
 * The brand rules this follows:
 * - Full colour wherever possible, the "S" always white. It needs a plain background that isn't
 *   green: white, the page, a dark surface. Never a green tint.
 * - Where full colour lacks contrast (the green `bg-accent` of `btn-primary`), pass `onAccent`
 *   for the monotone bag in white, or black in dark mode, whichever contrasts with the accent.
 * - Keep half the S of clear space around it. The view box pads the bag by about that, and the
 *   bag fills about 80% of `size`, as the old icon did.
 */
export function ShopifyIcon({ size = 18, className, onAccent = false }: { size?: number; className?: string; onAccent?: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="-19.5 -13.5 128 128" width={size} height={size} className={className}>
      {onAccent ? (
        <path className="fill-white dark:fill-black" d={MONOTONE} />
      ) : (
        <>
          <path fill="#95BF47" d={FULL_COLOUR_LEFT} />
          <path fill="#5E8E3E" d={FULL_COLOUR_RIGHT} />
          <path fill="#fff" d={FULL_COLOUR_S} />
        </>
      )}
    </svg>
  );
}

/* shopify-logo-shopping-bag-full-color.svg (view box 0 0 89 101). */
const FULL_COLOUR_LEFT =
  "M77.667 19.756c-.07-.505-.51-.785-.877-.816-.363-.03-7.482-.139-7.482-.139s-5.954-5.781-6.542-6.37c-.588-.588-1.736-.41-2.183-.277-.006.003-1.118.347-2.99.927a20.969 20.969 0 00-1.433-3.518c-2.12-4.045-5.224-6.184-8.974-6.19h-.014c-.261 0-.52.025-.78.047a11.451 11.451 0 00-.338-.39c-1.635-1.749-3.73-2.6-6.24-2.525-4.844.138-9.668 3.637-13.58 9.851-2.752 4.373-4.847 9.866-5.44 14.119l-9.539 2.954c-2.808.883-2.896.969-3.263 3.616-.271 2-7.618 58.807-7.618 58.807L61.94 100.5l26.683-6.633S77.737 20.26 77.667 19.756zM54.51 14.035l-4.778 1.479c-.036-2.453-.327-5.865-1.47-8.814 3.676.696 5.485 4.855 6.248 7.335zm-7.999 2.477l-10.279 3.183c.994-3.804 2.877-7.591 5.191-10.074.86-.924 2.064-1.953 3.49-2.541 1.34 2.796 1.632 6.755 1.598 9.432zm-6.6-12.784c1.138-.025 2.095.225 2.913.763-1.31.68-2.574 1.657-3.762 2.93-3.076 3.301-5.435 8.426-6.375 13.37-2.933.907-5.801 1.797-8.442 2.613 1.667-7.782 8.19-19.46 15.666-19.676z";
const FULL_COLOUR_RIGHT =
  "M76.793 18.943c-.363-.03-7.482-.139-7.482-.139s-5.954-5.782-6.542-6.37c-.22-.219-.516-.333-.827-.38l.003 88.443 26.68-6.63S77.74 20.263 77.67 19.758c-.07-.504-.513-.785-.877-.815z";
const FULL_COLOUR_S =
  "M47.152 32.662l-3.099 11.594s-3.456-1.573-7.554-1.315c-6.01.38-6.073 4.17-6.012 5.121.327 5.186 13.969 6.318 14.734 18.463.602 9.555-5.068 16.092-13.239 16.608-9.807.618-15.206-5.166-15.206-5.166l2.078-8.84s5.435 4.101 9.785 3.827c2.841-.18 3.856-2.492 3.754-4.126-.428-6.764-11.536-6.364-12.238-17.478-.59-9.352 5.552-18.83 19.104-19.684 5.221-.336 7.893.996 7.893.996z";

/* shopify-logo-shopping-bag-monotone-black.svg (same view box): the bag with the S and the gap
   cut out. The monotone-white file is the same drawing in white. */
const MONOTONE =
  "M63.36 100.258l25.312-6.29S77.774 20.285 77.705 19.779c-.07-.505-.511-.786-.878-.816-.364-.03-7.49-.14-7.49-.14s-4.344-4.218-5.977-5.815v87.25zm-2.756-88.091l-2.993.927a20.995 20.995 0 00-1.434-3.521c-2.121-4.05-5.23-6.191-8.984-6.197h-.014c-.261 0-.52.025-.78.048a11.465 11.465 0 00-.34-.392C44.425 1.282 42.328.43 39.813.505c-4.849.138-9.679 3.64-13.595 9.862-2.755 4.377-4.852 9.876-5.446 14.134-5.569 1.724-9.463 2.93-9.549 2.958-2.81.883-2.9.969-3.266 3.619-.275 2.002-7.63 58.87-7.63 58.87L61.344 100.5V12.042c-.3.02-.57.075-.739.125zM46.515 16.53l-10.29 3.185c.994-3.807 2.88-7.598 5.196-10.084.861-.925 2.067-1.955 3.494-2.544 1.342 2.8 1.633 6.763 1.6 9.443zM39.908 3.732c1.138-.025 2.097.225 2.916.764-1.311.68-2.578 1.658-3.766 2.932-3.08 3.305-5.441 8.435-6.383 13.384-2.935.909-5.807 1.8-8.451 2.617 1.67-7.79 8.199-19.48 15.684-19.697zM30.473 48.11c.328 5.19 13.984 6.324 14.75 18.483.603 9.565-5.074 16.109-13.253 16.625-9.818.62-15.223-5.174-15.223-5.174l2.08-8.851s5.441 4.105 9.796 3.83c2.844-.18 3.86-2.494 3.758-4.13-.428-6.771-11.548-6.371-12.25-17.497-.592-9.363 5.557-18.85 19.124-19.706 5.227-.33 7.904 1.006 7.904 1.006l-3.102 11.606s-3.46-1.575-7.563-1.316c-6.018.38-6.082 4.174-6.021 5.124zM49.74 15.533c-.037-2.455-.328-5.872-1.473-8.824 3.68.697 5.491 4.86 6.258 7.343-1.42.437-3.036.936-4.785 1.48z";
