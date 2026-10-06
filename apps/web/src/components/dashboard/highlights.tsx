"use client";
import type { ReactNode } from "react";
import { fmtMoney, fmtNum, fmtPct } from "@/lib/api";
import { hourRange, plural } from "./format";
import { SECTION_LABEL, STEP_LABEL } from "./funnel";
import { Icon, type IconName } from "./icons";
import type { Overview } from "./types";

type Tone = "accent" | "accent-2" | "good" | "danger" | "warn";

interface Highlight {
  id: string;
  icon: IconName;
  tone: Tone;
  title: string;
  text: ReactNode;
  /** Section of the page this is about. */
  href: string;
}

const TONE: Record<Tone, string> = {
  accent: "bg-accent/12 text-accent",
  "accent-2": "bg-accent-2/15 text-accent-2",
  good: "bg-good/12 text-good",
  danger: "bg-danger/12 text-danger",
  warn: "bg-warn/15 text-warn",
};

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-text">{children}</strong>;

/**
 * The few things worth knowing about these dates, in plain sentences, worked out from the
 * numbers already on the page. Each one links down to the card it comes from.
 */
function pick(ov: Overview, currency: string): Highlight[] {
  const m = ov.modules;
  const out: Highlight[] = [];

  const s = m.sales_overview;
  if (s && ov.hasData) {
    const d = s.deltas.netSales;
    out.push({
      id: "sales",
      icon: d !== null && d < 0 ? "trendDown" : "trendUp",
      tone: d === null ? "accent" : d >= 0 ? "good" : "danger",
      title: "Sales",
      text:
        d === null ? (
          <><B>{fmtMoney(s.current.netSales, currency)}</B> from {plural(s.current.orders, "order")}.</>
        ) : (
          <><B>{fmtMoney(s.current.netSales, currency)}</B>, {d >= 0 ? "up" : "down"} <B>{fmtPct(Math.abs(d))}</B> on the period before.</>
        ),
      href: "#sales",
    });
  }

  const f = m.funnel;
  if (f && f.visits > 0) {
    const leak = f.steps.slice(0, -1).reduce((a, b) => (b.left > a.left ? b : a));
    const where = leak.leftFrom.find((x) => x.section)?.section;
    if (leak.left > 0) {
      out.push({
        id: "leak",
        icon: "door",
        tone: "danger",
        title: "Biggest drop-off",
        text: (
          <><B>{fmtNum(leak.left)}</B> shoppers stopped at “{STEP_LABEL[leak.step].toLowerCase()}”{where ? <>, most of them on <B>{SECTION_LABEL[where].toLowerCase()}</B></> : null}.</>
        ),
        href: "#funnel",
      });
    }
    out.push({
      id: "conversion",
      icon: "eye",
      tone: "accent",
      title: "Visitors who bought",
      text: <><B>{fmtPct(f.conversionRate)}</B> of {fmtNum(f.visits)} visits ended in a purchase.</>,
      href: "#funnel",
    });
  }

  const top = m.top_products?.items[0];
  if (top) {
    out.push({
      id: "best",
      icon: "trophy",
      tone: "accent-2",
      title: "Best seller",
      text: <><B>{top.title}</B> brought in {fmtMoney(top.revenue, currency)} ({plural(top.units, "unit")}).</>,
      href: "#top-products",
    });
  }

  const t = m.order_timing;
  if (t && t.busiestDay && t.busiestHour !== null && t.byWeekday.some((n) => n > 0)) {
    out.push({
      id: "timing",
      icon: "clock",
      tone: "accent",
      title: "Busiest time",
      text: <><B>{t.busiestDay}s</B>, especially <B>{hourRange(t.busiestHour)}</B>.</>,
      href: "#order_timing",
    });
  }

  const inv = m.inventory?.current;
  if (inv && inv.lowStock + inv.outOfStock > 0) {
    out.push({
      id: "stock",
      icon: "box",
      tone: "warn",
      title: "Stock to watch",
      text: <><B>{fmtNum(inv.lowStock)}</B> running low{inv.outOfStock > 0 ? <> and <B>{fmtNum(inv.outOfStock)}</B> sold out</> : null}.</>,
      href: "#inventory",
    });
  }

  const ful = m.fulfillment;
  if (ful && ful.openNow > 0) {
    out.push({
      id: "ship",
      icon: "truck",
      tone: (ful.oldestOpenDays ?? 0) > 3 ? "danger" : "warn",
      title: "Waiting to ship",
      text: <><B>{plural(ful.openNow, "order")}</B>{ful.oldestOpenDays !== null ? <>, the oldest for {plural(ful.oldestOpenDays, "day")}</> : null}.</>,
      href: "#fulfillment",
    });
  }

  const ch = m.channels?.items[0];
  if (ch && ch.share !== null && (m.channels?.items.length ?? 0) > 1) {
    out.push({
      id: "channel",
      icon: "store",
      tone: "accent-2",
      title: "Top channel",
      text: <><B>{ch.label}</B> brings in {fmtPct(ch.share)} of sales.</>,
      href: "#channels",
    });
  }

  return out.slice(0, 6);
}

export function Highlights({ ov, currency, period }: { ov: Overview; currency: string; period: string }) {
  const items = pick(ov, currency);
  if (items.length === 0) return null;
  return (
    <section id="highlights" className="scroll-mt-28" aria-labelledby="highlights-h">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 id="highlights-h" className="flex items-center gap-2 font-semibold">
          <Icon name="sparkle" className="h-5 w-5 text-accent-2" />
          What stands out
        </h2>
        <span className="text-xs text-muted">{period}</span>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((h, i) => (
          <li key={h.id} className="animate-rise" style={{ ["--i" as string]: i }}>
            <a href={h.href} className="card lift group flex h-full items-start gap-3 p-4" data-testid={`highlight-${h.id}`}>
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-110 ${TONE[h.tone]}`}>
                <Icon name={h.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium uppercase tracking-wide text-muted">{h.title}</span>
                <span className="mt-0.5 block text-sm text-muted">{h.text}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
