import type { ReactNode, SVGProps } from "react";

/** A small set of line icons for the dashboard (24×24, drawn with currentColor). */
function Svg({ children, ...p }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {children}
    </svg>
  );
}

export type IconName = "trendUp" | "trendDown" | "bag" | "receipt" | "trophy" | "clock" | "door" | "box" | "truck" | "mail" | "users" | "eye" | "sparkle" | "refresh" | "copy" | "check" | "external" | "phone" | "cart" | "store" | "chart" | "link" | "close" | "chevronRight" | "tag" | "printer" | "chat" | "share" | "megaphone" | "coins";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const p = { className };
  switch (name) {
    case "trendUp":
      return <Svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></Svg>;
    case "trendDown":
      return <Svg {...p}><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></Svg>;
    case "bag":
      return <Svg {...p}><path d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></Svg>;
    case "receipt":
      return <Svg {...p}><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" /><path d="M9 8h6M9 12h6" /></Svg>;
    case "trophy":
      return <Svg {...p}><path d="M8 4h8v5a4 4 0 0 1-8 0V4z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M10 17h4" /></Svg>;
    case "clock":
      return <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
    case "door":
      return <Svg {...p}><path d="M14 3H6v18h8" /><path d="M10 12h11M18 9l3 3-3 3" /></Svg>;
    case "box":
      return <Svg {...p}><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></Svg>;
    case "truck":
      return <Svg {...p}><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></Svg>;
    case "mail":
      return <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></Svg>;
    case "users":
      return <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></Svg>;
    case "eye":
      return <Svg {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Svg>;
    case "sparkle":
      return <Svg {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" /></Svg>;
    case "refresh":
      return <Svg {...p}><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 3v5h5M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 21v-5h-5" /></Svg>;
    case "copy":
      return <Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Svg>;
    case "check":
      return <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
    case "external":
      return <Svg {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Svg>;
    case "phone":
      return <Svg {...p}><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" /></Svg>;
    case "cart":
      return <Svg {...p}><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l2.7 12.2a2 2 0 0 0 2 1.6h8.1a2 2 0 0 0 2-1.5L21 8H6" /></Svg>;
    case "store":
      return <Svg {...p}><path d="M4 10v10h16V10" /><path d="M3 10l2-6h14l2 6a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M10 20v-5h4v5" /></Svg>;
    case "link":
      return <Svg {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></Svg>;
    case "chart":
      return <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
    case "close":
      return <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
    case "chevronRight":
      return <Svg {...p}><path d="M9 5l7 7-7 7" /></Svg>;
    case "coins":
      return <Svg {...p}><ellipse cx="9" cy="7" rx="5" ry="2.5" /><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7" /><path d="M10 15.4c.9.7 2.5 1.1 4.5 1.1 2.8 0 5-1.1 5-2.5V10c0-1.4-2.2-2.5-5-2.5" /><path d="M10 15.4V18c.9.9 2.5 1.5 4.5 1.5 2.8 0 5-1.1 5-2.5v-3" /></Svg>;
    case "megaphone":
      return <Svg {...p}><path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z" /><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></Svg>;
    case "chat":
      return <Svg {...p}><path d="M4 5h16v11H9l-5 4V5z" /><path d="M8 9h8M8 12h5" /></Svg>;
    case "share":
      return <Svg {...p}><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4" /></Svg>;
    case "printer":
      return <Svg {...p}><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></Svg>;
    case "tag":
      return <Svg {...p}><path d="M3 12V4h8l10 10-8 8L3 12z" /><circle cx="7.5" cy="8.5" r="1.5" /></Svg>;
  }
}
