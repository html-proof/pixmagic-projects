import type { AdSpendProvider } from "./ads";

/**
 * The Advertising overview's "Key insights": a few plain sentences drawn from figures the API already
 * worked out (the ad module's totals and changes, each platform's own, Shopify's margin on the sales it
 * has a cost for). Nothing is estimated beyond what the sentence says: a figure not known leaves its
 * insight out, never a guess. Purchases, purchase value and ROAS are each platform's own claim and are
 * worded so; the store's sales are Shopify's.
 */

export type AdInsightTone = "good" | "bad" | "warn" | "info";

export interface AdInsight {
  id: "value_change" | "spend_outpaces" | "best_roas" | "below_one" | "share" | "no_purchases" | "break_even" | "roas_meaning";
  tone: AdInsightTone;
  text: string;
}

/** One platform's shown figures (its totals for the dates, or the days so far). */
export interface AdInsightPlatform {
  provider: AdSpendProvider;
  spend: number;
  /** Null while some day's aren't read yet. */
  purchases: number | null;
  purchaseValue: number | null;
  roas: number | null;
}

export interface AdInsightInput {
  platforms: readonly AdInsightPlatform[];
  /** Every platform together; null when not known. */
  totals: { spend: number; purchases: number | null; purchaseValue: number | null; roas: number | null } | null;
  /** The changes on the dates compared with, as fractions (0.1 = 10%); null with nothing compared. */
  deltas: { spend: number | null; purchases: number | null; purchaseValue: number | null } | null;
  /** "vs 1 – 7 Oct": what the changes are on. */
  versus: string | null;
  /** Shopify's gross margin on the sales it has a cost recorded for (0–1); null when not known. */
  margin: number | null;
  /** Simulated figures (the Google Ads demo) are among the platforms: nothing is set against the store. */
  demo?: boolean;
}

export interface AdInsightFormat {
  money: (n: number) => string;
  /** A fraction as a percentage: 0.287 → "28.7%". */
  pct: (n: number) => string;
  /** A ratio: 4.32 → "4.32×". */
  times: (n: number) => string;
}

const NAME: Record<AdSpendProvider, string> = { meta: "Meta Ads", google: "Google Ads" };
/** Changes smaller than this either way aren't news. */
const NOTABLE = 0.05;

/** At most `limit` insights, the most telling first. */
export function advertisingInsights(input: AdInsightInput, f: AdInsightFormat, limit = 4): AdInsight[] {
  const out: AdInsight[] = [];
  const { totals, deltas, versus } = input;
  const spending = input.platforms.filter((p) => p.spend > 0);

  // Spend with no purchase at all: the most useful thing to say, usually tracking.
  if (totals && totals.spend > 0 && totals.purchases === 0) {
    out.push({
      id: "no_purchases",
      tone: "warn",
      text: `The platforms counted no purchases from ${f.money(totals.spend)} of ad spend. If your ads do sell, check that the Meta pixel or the Google Ads conversion tag reports purchases.`,
    });
  }

  // Each platform's ROAS below 1: it credits less than it cost, even before product costs.
  for (const p of spending) {
    if (p.purchases !== null && p.purchases > 0 && p.roas !== null && p.roas < 1) {
      out.push({ id: "below_one", tone: "bad", text: `${NAME[p.provider]} credits less in purchases than it cost: a ROAS of ${f.times(p.roas)}, by its own count.` });
    }
  }

  // Spend up while purchases fell.
  if (deltas && versus && deltas.spend !== null && deltas.purchases !== null && deltas.spend >= NOTABLE && deltas.purchases < 0) {
    out.push({ id: "spend_outpaces", tone: "warn", text: `Ad spend is up ${f.pct(deltas.spend)} ${versus} while the platforms counted ${f.pct(-deltas.purchases)} fewer purchases.` });
  } else if (deltas && versus && deltas.purchaseValue !== null && Math.abs(deltas.purchaseValue) >= NOTABLE) {
    const up = deltas.purchaseValue > 0;
    out.push({ id: "value_change", tone: up ? "good" : "bad", text: `The purchase value your platforms credit to their ads is ${up ? "up" : "down"} ${f.pct(Math.abs(deltas.purchaseValue))} ${versus}.` });
  }

  // Which platform returned more per unit of spend, by each one's own count.
  const rated = spending.filter((p): p is AdInsightPlatform & { roas: number } => p.roas !== null && p.purchases !== null && p.purchases > 0);
  if (rated.length >= 2) {
    const [best, next] = [...rated].sort((a, b) => b.roas - a.roas);
    if (best!.roas > next!.roas) {
      out.push({
        id: "best_roas",
        tone: "good",
        text: `${NAME[best!.provider]} returns the most per ${f.money(1)}: ${f.times(best!.roas)} against ${NAME[next!.provider]}'s ${f.times(next!.roas)}, each by its own count.`,
      });
    }
  }

  // Break-even: what ROAS pays for the products sold, at Shopify's margin.
  const roas = totals?.purchases ? totals.roas : null;
  if (!input.demo && roas !== null && input.margin !== null && input.margin > 0 && input.margin < 1) {
    const breakEven = 1 / input.margin;
    const covers = roas >= breakEven;
    out.push({
      id: "break_even",
      tone: covers ? "good" : "warn",
      text: `At your products' ${f.pct(input.margin)} margin, ads pay for what they sell above a ROAS of ${f.times(breakEven)}: yours is ${f.times(roas)}${covers ? "." : ", so the platforms' sales don't yet cover their product costs and the spend."}`,
    });
  }

  // Where the money went, with two platforms spending.
  if (spending.length >= 2 && totals && totals.spend > 0) {
    const top = [...spending].sort((a, b) => b.spend - a.spend)[0]!;
    out.push({ id: "share", tone: "info", text: `${NAME[top.provider]} took ${f.pct(top.spend / totals.spend)} of your ad spend.` });
  }

  // What the ROAS means, once: a return on spend isn't profit.
  if (roas !== null && roas > 0) {
    out.push({
      id: "roas_meaning",
      tone: "info",
      text: `A ROAS of ${f.times(roas)} means the platforms credit ${f.money(roas)} of purchases to every ${f.money(1)} spent: before product costs, fees and your other costs, so it isn't profit.`,
    });
  }

  return out.slice(0, limit);
}
