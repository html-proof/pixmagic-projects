/**
 * What the headline figures measure, in a merchant's words: the note behind the small "i" beside a
 * figure's name (components/PageKit.tsx HelpTip) on the Home and the Sales pages. One wording per
 * figure, so a number is explained the same wherever it shows. The definitions themselves are
 * docs/kpis.md "Metric registry" and "Formulas": change a note only with the figure it describes.
 */
export const FIGURE_HELP = {
  totalSales: "Everything customers were charged in these dates: your products after discounts and returns, plus shipping and tax. The same figure as Shopify's Total sales.",
  netSales: "What your products sold for in these dates, after discounts and returns. Shipping and tax aren't in it.",
  orders: "Orders placed in these dates, cancelled ones included. Test orders are never counted.",
  averageOrder: "What a typical order was worth when it was placed: its items after discounts, before tax and shipping.",
  itemsSold: "Items sold in these dates, with returned items taken off.",
  netProfit: "What is left of your sales in these dates once product costs, ad spend and your own costs are taken off.",
  leftOver: "Net sales less the costs bizinsights knows about, named under the figure. Not profit: bizinsights may not have every cost.",
} as const;

/** "Visits that bought": the share is of the visits bizinsights tracked, so the note says how many those were. */
export const visitsThatBoughtHelp = (visits: number): string =>
  `The share of visits to your store that ended in an order, of the ${new Intl.NumberFormat().format(visits)} ${visits === 1 ? "visit" : "visits"} bizinsights tracked in these dates.`;
