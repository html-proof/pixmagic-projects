import {
  ChartColumn,
  Check,
  ChevronRight,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  Eye,
  Link,
  LogOut,
  Mail,
  Megaphone,
  MessageCircle,
  Package,
  Phone,
  Printer,
  Receipt,
  RefreshCw,
  Share2,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Store,
  Tag,
  TrendingDown,
  TrendingUp,
  Trophy,
  Truck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The dashboard's line icons, by name. They are Lucide's (lucide-react, ISC licence), the one icon
 * set the whole app uses, so the dashboard, settings and sign-in pages share a single style.
 * Decorative: whatever the icon stands for is always said in text next to it.
 */
const ICONS = {
  trendUp: TrendingUp,
  trendDown: TrendingDown,
  bag: ShoppingBag,
  receipt: Receipt,
  trophy: Trophy,
  clock: Clock,
  door: LogOut,
  box: Package,
  truck: Truck,
  mail: Mail,
  users: Users,
  eye: Eye,
  sparkle: Sparkles,
  refresh: RefreshCw,
  copy: Copy,
  check: Check,
  external: ExternalLink,
  phone: Phone,
  cart: ShoppingCart,
  store: Store,
  chart: ChartColumn,
  link: Link,
  close: X,
  chevronRight: ChevronRight,
  tag: Tag,
  printer: Printer,
  chat: MessageCircle,
  share: Share2,
  megaphone: Megaphone,
  coins: Coins,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph className={className} size={20} strokeWidth={1.8} aria-hidden="true" />;
}
