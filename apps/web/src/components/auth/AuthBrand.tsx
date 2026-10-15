import { useId } from "react";

/** The green bar-chart mark of the split auth pages (AuthSplitShell). */
export function AuthMark({ size = 28 }: { size?: number }) {
  // Drawn twice on wide screens (showcase and form), and the showcase is hidden on phones.
  const id = `auth-mark-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7be3a8" />
          <stop offset="100%" stopColor="#23935c" />
        </linearGradient>
      </defs>
      <rect x="3" y="15" width="6" height="10" rx="2" fill={`url(#${id})`} opacity="0.75" />
      <rect x="11" y="9.5" width="6" height="15.5" rx="2" fill={`url(#${id})`} opacity="0.88" />
      <path d="M19 9.4c0-1.4 1-2.6 2.4-2.9l2.1-.4c.8-.2 1.5.4 1.5 1.2V23c0 1.1-.9 2-2 2h-2c-1.1 0-2-.9-2-2z" fill={`url(#${id})`} />
    </svg>
  );
}

export function AuthLogo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-[19px] font-semibold tracking-tight ${className}`}>
      <AuthMark />
      Insights
    </span>
  );
}
