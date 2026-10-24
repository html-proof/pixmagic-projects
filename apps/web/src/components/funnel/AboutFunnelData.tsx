"use client";
import { fmtDay } from "@/components/dashboard/format";
import type { FunnelPageModule, Overview } from "@/components/dashboard/types";
import { FunnelSection } from "./FunnelUi";
import { FORMULAS } from "./stageGuide";

const SOURCES: Array<[figure: string, measured: string, source: string]> = [
  ["Store visits", "Tracked visits: one shopper (browser) on one store-local day", "bizinsights storefront pixel"],
  ["Product views, Added to cart, Reached checkout", "Visits that reached the step or a later one", "bizinsights storefront pixel"],
  ["Completed purchases", "Visits that completed checkout", "bizinsights storefront pixel"],
  ["Conversion rate", FORMULAS.conversion, "bizinsights storefront pixel"],
  ["Orders, net sales, average order value", "Every order in the dates, from every sales channel, net of returns", "Your Shopify orders"],
  ["Product orders, units and net sales", "Orders that included the product, units net of returns", "Your Shopify orders"],
  ["Orders by traffic source", "Shopify's record of the last visit before each order", "Your Shopify orders"],
  ["Device and country", "The browser's own description, and the country our network placed the request in (one word each; nothing else kept)", "bizinsights storefront pixel"],
];

/**
 * How the page's numbers are made: where each comes from, the formulas, how far back they go, and
 * what the funnel can't show (yet), so no figure reads as more than it is.
 */
export function AboutFunnelData({ f, ov }: { f: FunnelPageModule | null; ov: Overview }) {
  const sessions = ov.modules.shopify_sessions;
  const capability = ov.capabilities.find((c) => c.id === "shopify_sessions");
  return (
    <FunnelSection id="about" title="About these numbers" sub="Where every figure on this page comes from, how it is calculated, and what it can't tell you.">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Where each figure comes from</h3>
          <div className="-mx-1 mt-2 overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-1 pb-2 font-normal">Figure</th>
                  <th className="px-1 pb-2 font-normal">Measured as</th>
                  <th className="px-1 pb-2 font-normal">Source</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.map(([figure, measured, source]) => (
                  <tr key={figure} className="border-t border-border align-top">
                    <td className="px-1 py-2 font-medium">{figure}</td>
                    <td className="px-1 py-2 text-muted">{measured}</td>
                    <td className="px-1 py-2 text-muted">{source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-5 text-sm font-semibold">Formulas</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Share of visits = {FORMULAS.share}</li>
            <li>Progression rate = {FORMULAS.progression}</li>
            <li>Drop-off rate = {FORMULAS.dropOff}</li>
            <li>Conversion rate = {FORMULAS.conversion}</li>
            <li>Checkout completion = {FORMULAS.checkoutCompletion}</li>
            <li>View to cart rate = {FORMULAS.viewToCart}</li>
          </ul>
        </div>
        <div className="min-w-0 space-y-4 text-sm">
          <div>
            <h3 className="font-semibold">How far back the data goes</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>
                {f?.historyFrom ? <>Visits are counted from {fmtDay(f.historyFrom, { year: true })}, the first whole day after the bizinsights pixel was added to your store. Shopify doesn&apos;t share visits from before an app&apos;s pixel was added.</> : <>No visits have been recorded yet.</>}
              </li>
              <li>{f?.detailsFrom ? <>Device, country and product pages are recorded from {fmtDay(f.detailsFrom, { year: true })}; visits before that show as &ldquo;Not recorded&rdquo;.</> : <>Device, country and product pages are recorded from now on.</>}</li>
              <li>You can pick any dates since then, up to 12 months at a time. Orders go back as far as bizinsights imported them.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">What these numbers can&apos;t show</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Shoppers who decline analytics tracking in your store&apos;s cookie banner aren&apos;t counted, so visits are lower than Shopify&apos;s sessions. Use them for trends and rates.</li>
              <li>The same shopper on another device or browser counts as another visitor.</li>
              <li>Where each visit came from (search, social, email…) isn&apos;t recorded: the traffic source breakdown shows your orders instead.</li>
              <li>Checkout isn&apos;t recorded per product, and a visit&apos;s purchase isn&apos;t matched to its order, so revenue is for all orders in the dates, not only tracked visits.</li>
              <li>Today&apos;s visits include ones still in progress.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">Shopify&apos;s own session count</h3>
            <p className="mt-1 text-muted">
              {sessions?.status === "ready"
                ? "Shopify's own sessions and conversion rate are shown below. Shopify counts every session (ending one after 30 minutes idle, bots left out), so its figures differ from tracked visits."
                : capability && !capability.enabled
                  ? "Shopify Analytics' own sessions need access to your Shopify reports, which bizinsights is waiting on Shopify to approve. Until then only tracked visits are shown, and they are never called sessions."
                  : "Shopify Analytics' own sessions appear below once Shopify answers."}
            </p>
          </div>
        </div>
      </div>
    </FunnelSection>
  );
}
