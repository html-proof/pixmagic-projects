"use client";
import { useId } from "react";

/**
 * Shopify-style shopping bag drawn in `currentColor`, with the "S" cut out so the button
 * colour shows through. Decorative: the button text carries the accessible name.
 */
export function ShopifyIcon({ size = 18, className }: { size?: number; className?: string }) {
  const mask = `shopify-s-${useId().replace(/:/g, "")}`;
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width={size} height={size} className={className}>
      <defs>
        <mask id={mask}>
          <rect width="24" height="24" fill="white" />
          <path
            d="M14.3 11.6c-.5-.6-1.3-.9-2.2-.9-1.3 0-2.2.7-2.2 1.7 0 2.3 4.6 1.4 4.6 3.9 0 1.1-1 1.9-2.4 1.9-1 0-1.9-.4-2.5-1.1"
            fill="none"
            stroke="black"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <path d="M8.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M4.9 7.5h14.2l1.1 12.9a1.5 1.5 0 0 1-1.5 1.6H5.3a1.5 1.5 0 0 1-1.5-1.6z" fill="currentColor" mask={`url(#${mask})`} />
    </svg>
  );
}
