import { CAPABILITIES, scopeList } from "@app/shared/capabilities";

/**
 * What else stops with a permission besides the dashboard reports named for it (CAPABILITIES):
 * parts of other panels that read it too. Shopify's reports also feed the check of the sales details
 * against Shopify's sales report (packages/core/src/reports/overview.ts) and the product costs in
 * Business profit overview. Not the daily "Checked against Shopify" beside the store's status: that
 * one reads orders, and keeps working.
 */
const ALSO_STOPS: Partial<Record<string, string[]>> = {
  read_reports: ["the check of your sales against Shopify's sales report", "the product costs and net profit in Business profit overview"],
};

/** The reports and parts of the dashboard that stop working without `scope`, so a confirm can name them. */
export function stopsWithout(scope: string): string[] {
  return [...CAPABILITIES.filter((c) => c.requiredScopes.includes(scope)).map((c) => c.title), ...(ALSO_STOPS[scope] ?? [])];
}

/**
 * Settings → Stores' words for removing one optional permission. The label goes mid-sentence through
 * `scopeList`, which lowers only its first letter: "your Shopify reports", never "your shopify reports".
 */
export function revokeWords(scope: string, domain: string) {
  const what = scopeList([scope]);
  const stops = stopsWithout(scope);
  return {
    question: `Stop letting bizinsights read ${what} for ${domain}?`,
    consequence: stops.length ? `${new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(stops)} will stop working until you grant it again.` : "Nothing on your dashboard uses it today.",
    button: `Remove ${what} permission for ${domain}`,
    failed: `We couldn't remove ${what}. Please try again.`,
  };
}
