const { apiUrl } = require("../lib/api");

// Totals of the store's stored Meta and Google Ads figures for chosen dates (no call to Meta or Google:
// as fresh as bizinsights' last sync, which the answer says). Empty without an ad account connected.
module.exports = {
  key: "find_ad_performance",
  noun: "Ad Performance",
  display: {
    label: "Find Ad Performance",
    description: "Finds the store's Meta and Google Ads spend, impressions, clicks and conversions for the dates you choose, as stored in bizinsights.",
  },
  operation: {
    inputFields: [
      { key: "platform", label: "Platform", choices: { any: "Meta and Google Ads", meta: "Meta Ads", google: "Google Ads" }, default: "any" },
      { key: "since", label: "From", type: "datetime", helpText: "The first day (the store's calendar). Empty: 7 days before To." },
      { key: "until", label: "To", type: "datetime", helpText: "The last day. Empty: yesterday." },
    ],
    perform: async (z, bundle) => {
      const params = { platform: bundle.inputData.platform || "any" };
      if (bundle.inputData.since) params.since = String(bundle.inputData.since).slice(0, 10);
      if (bundle.inputData.until) params.until = String(bundle.inputData.until).slice(0, 10);
      return (await z.request({ url: apiUrl("/zapier/search/ad-performance"), params })).data;
    },
    sample: {
      id: "ad_performance:store_example:any:2026-10-21:2026-10-27",
      platform: "any",
      since: "2026-10-21",
      until: "2026-10-27",
      spend: 280.5,
      currency: "AUD",
      mixed_currencies: null,
      impressions: 6400,
      clicks: 210,
      conversions: 12,
      platform_attributed_purchase_value: 960,
      platform_attributed_roas: 3.42,
      accounts: [],
      last_successful_sync_at: "2026-10-28T08:55:00.000Z",
      data_through: "2026-10-27",
      freshness_note: "Figures as stored in bizinsights at its last sync with each platform.",
      attribution_note: "Purchase value and ROAS are what each ad platform credits to its own ads (its attribution), not the store's revenue.",
    },
    outputFields: [
      { key: "spend", label: "Spend", type: "number" },
      { key: "currency", label: "Currency" },
      { key: "impressions", label: "Impressions", type: "integer" },
      { key: "clicks", label: "Clicks", type: "integer" },
      { key: "conversions", label: "Conversions (as the platforms count them)", type: "number" },
      { key: "platform_attributed_purchase_value", label: "Purchase value the platforms credit to their ads", type: "number" },
      { key: "platform_attributed_roas", label: "ROAS as the platforms credit it", type: "number" },
      { key: "last_successful_sync_at", label: "Last sync", type: "datetime" },
    ],
  },
};
