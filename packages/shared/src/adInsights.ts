import { claimsAddUp, type AdSpendProvider } from "./ads";

/**
 * The Advertising overview's "Key insights": a few plain sentences drawn from figures the API already
 * worked out (the ad module's totals and changes, each platform's own, Shopify's margin on the sales it
 * has a cost for). Nothing is estimated beyond what the sentence says: a figure not known leaves its
 * insight out, never a guess. Purchases, purchase value and ROAS are each platform's own claim and are
 * worded so; the store's sales are Shopify's. With Meta and Google both counted their claims are never
 * added up (`claimsAddUp`: both can credit one order): a sentence on purchases names each platform's own.
 */

export type AdInsightTone = "good" | "bad" | "warn" | "info";

export interface AdInsight {
  id: "value_change" | "spend_outpaces" | "best_roas" | "below_one" | "share" | "no_purchases" | "break_even" | "roas_meaning";
  tone: AdInsightTone;
  text: string;
  /** The one platform the sentence is about, when there can be one per platform. */
  provider?: AdSpendProvider;
}

/** One platform's shown figures (its totals for the dates, or the days so far). */
export interface AdInsightPlatform {
  provider: AdSpendProvider;
  spend: number;
  /** Null while some day's aren't read yet. */
  purchases: number | null;
  purchaseValue: number | null;
  roas: number | null;
  /** Its own changes, as `AdInsightInput.deltas`, on the dates in `versus`; absent or null with nothing compared. */
  deltas?: { spend: number | null; purchases: number | null; purchaseValue: number | null } | null;
  versus?: string | null;
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
  /**
   * The ads module's `claimsAddUp`: the purchases, purchase value and ROAS of `totals` and `deltas` are
   * one platform's. False: they add up the claims of more than one, so only each platform's own are
   * used. Absent: worked out from `platforms`.
   */
  claimsAddUp?: boolean;
}

export interface AdInsightFormat {
  money: (n: number) => string;
  /** One unit of the currency, whole: "₹1", "$1". */
  unit: string;
  /** A fraction as a percentage: 0.287 → "28.7%". */
  pct: (n: number) => string;
  /** A ratio: 4.32 → "4.32×". */
  times: (n: number) => string;
}

const NAME: Record<AdSpendProvider, string> = { meta: "Meta Ads", google: "Google Ads" };
/** Changes smaller than this either way aren't news. */
const NOTABLE = 0.05;

/** "Meta Ads and Google Ads". */
const names = (list: readonly AdInsightPlatform[]) => list.map((p) => NAME[p.provider]).join(" and ");

/** At most `limit` insights, the most telling first. */
export function advertisingInsights(input: AdInsightInput, f: AdInsightFormat, limit = 4): AdInsight[] {
  const out: AdInsight[] = [];
  const { totals, deltas, versus } = input;
  const spending = input.platforms.filter((p) => p.spend > 0);
  // More than one platform's claims in the totals: each platform's own only, never their sum.
  const apart = !(input.claimsAddUp ?? claimsAddUp(input.platforms.map((p) => p.provider)));
  // The platforms whose ROAS stands for something: spend, and purchases credited to it.
  const rated = spending.filter((p): p is AdInsightPlatform & { roas: number } => p.roas !== null && p.purchases !== null && p.purchases > 0);

  // Spend with no purchase at all: the most useful thing to say, usually tracking. (A sum of 0 is no
  // claim added up: none of the platforms counted one.)
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
      out.push({ id: "below_one", tone: "bad", provider: p.provider, text: `${NAME[p.provider]} credits less in purchases than it cost: a ROAS of ${f.times(p.roas)}, by its own count.` });
    }
  }

  // Spend up while purchases fell; otherwise the purchase value's change. Each platform's own when
  // their claims don't add up.
  if (apart) {
    for (const p of spending) {
      const d = p.deltas;
      if (!d || !p.versus) continue;
      if (d.spend !== null && d.purchases !== null && d.spend >= NOTABLE && d.purchases < 0) {
        out.push({ id: "spend_outpaces", tone: "warn", provider: p.provider, text: `${NAME[p.provider]} spend is up ${f.pct(d.spend)} ${p.versus} while it counted ${f.pct(-d.purchases)} fewer purchases.` });
      } else if (d.purchaseValue !== null && Math.abs(d.purchaseValue) >= NOTABLE) {
        const up = d.purchaseValue > 0;
        out.push({ id: "value_change", tone: up ? "good" : "bad", provider: p.provider, text: `The purchase value ${NAME[p.provider]} credits to its ads is ${up ? "up" : "down"} ${f.pct(Math.abs(d.purchaseValue))} ${p.versus}.` });
      }
    }
  } else if (deltas && versus && deltas.spend !== null && deltas.purchases !== null && deltas.spend >= NOTABLE && deltas.purchases < 0) {
    out.push({ id: "spend_outpaces", tone: "warn", text: `Ad spend is up ${f.pct(deltas.spend)} ${versus} while the platforms counted ${f.pct(-deltas.purchases)} fewer purchases.` });
  } else if (deltas && versus && deltas.purchaseValue !== null && Math.abs(deltas.purchaseValue) >= NOTABLE) {
    const up = deltas.purchaseValue > 0;
    out.push({ id: "value_change", tone: up ? "good" : "bad", text: `The purchase value your platforms credit to their ads is ${up ? "up" : "down"} ${f.pct(Math.abs(deltas.purchaseValue))} ${versus}.` });
  }

  // Which platform returned more per unit of spend, by each one's own count.
  if (rated.length >= 2) {
    const [best, next] = [...rated].sort((a, b) => b.roas - a.roas);
    if (best!.roas > next!.roas) {
      out.push({
        id: "best_roas",
        tone: "good",
        text: `${NAME[best!.provider]} returns the most per ${f.unit} spent: ${f.times(best!.roas)}, against ${f.times(next!.roas)} for ${NAME[next!.provider]}, each by its own count.`,
      });
    }
  }

  // Break-even: what ROAS pays for the products sold, at Shopify's margin; set against each platform's
  // own ROAS when their claims don't add up.
  const roas = !apart && totals?.purchases ? totals.roas : null;
  const margin = !input.demo && input.margin !== null && input.margin > 0 && input.margin < 1 ? input.margin : null;
  if (margin !== null && apart && rated.length) {
    const breakEven = 1 / margin;
    const short = rated.filter((p) => p.roas < breakEven);
    const each = rated.map((p, i) => `${i === 0 ? `${NAME[p.provider]} reports` : NAME[p.provider]} ${f.times(p.roas)}`).join(" and ");
    out.push({
      id: "break_even",
      tone: short.length ? "warn" : "good",
      text: `At your products' ${f.pct(margin)} margin, ads pay for what they sell above a ROAS of ${f.times(breakEven)}: ${each}, ${rated.length > 1 ? "each by its own count" : "by its own count"}${
        short.length ? `, so the sales ${names(short)} ${short.length > 1 ? "credit to their ads don't yet cover their product costs and the spend" : "credits to its ads don't yet cover their product costs and its spend"}.` : "."
      }`,
    });
  } else if (margin !== null && roas !== null) {
    const breakEven = 1 / margin;
    const covers = roas >= breakEven;
    out.push({
      id: "break_even",
      tone: covers ? "good" : "warn",
      text: `At your products' ${f.pct(margin)} margin, ads pay for what they sell above a ROAS of ${f.times(breakEven)}: yours is ${f.times(roas)}${covers ? "." : ", so the platforms' sales don't yet cover their product costs and the spend."}`,
    });
  }

  // Where the money went, with two platforms spending.
  if (spending.length >= 2 && totals && totals.spend > 0) {
    const top = [...spending].sort((a, b) => b.spend - a.spend)[0]!;
    out.push({ id: "share", tone: "info", text: `${NAME[top.provider]} took ${f.pct(top.spend / totals.spend)} of your ad spend.` });
  }

  // What the ROAS means, once: a return on spend isn't profit. Each platform's own, named, when their
  // claims don't add up.
  const meant = rated.filter((p) => p.roas > 0);
  if (apart && meant.length) {
    const [first, ...rest] = meant;
    const others = rest.map((p) => `, ${NAME[p.provider]}' ${f.times(p.roas)} that it credits ${f.money(p.roas)}`).join("");
    out.push({
      id: "roas_meaning",
      tone: "info",
      text: `${NAME[first!.provider]}' ROAS of ${f.times(first!.roas)} means it credits ${f.money(first!.roas)} of purchases to every ${f.unit} spent${others}, ${meant.length > 1 ? "each by its own count" : "by its own count"}: before product costs, fees and your other costs, so it isn't profit.`,
    });
  } else if (roas !== null && roas > 0) {
    out.push({
      id: "roas_meaning",
      tone: "info",
      text: `A ROAS of ${f.times(roas)} means the platforms credit ${f.money(roas)} of purchases to every ${f.unit} spent: before product costs, fees and your other costs, so it isn't profit.`,
    });
  }

  return out.slice(0, limit);
}
