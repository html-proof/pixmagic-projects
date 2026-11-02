const { apiUrl } = require("../lib/api");

// The store's stored Meta and Google Ads figures for chosen dates, each platform's own (`platforms`) and
// together (no call to Meta or Google: as fresh as bizinsights' last sync, which the answer says). A
// platform without an ad account in bizinsights counts the spend its app reported to Shopify (source
// "shopify_marketing"). Empty with neither.
module.exports = {
  key: "find_ad_performance",
  noun: "Ad Performance",
  display: {
    label: "Find Ad Performance",
    description: "Finds the store's Meta and Google Ads spend, impressions, clicks and conversions for the dates you choose, each platform's own and together, as stored in bizinsights or reported to Shopify.",
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
      claims_add_up: false,
      platforms: [
        {
          platform: "meta",
          name: "Meta Ads",
          source: "platform_api",
          spend: 180.5,
          currency: "AUD",
          mixed_currencies: null,
          impressions: 4200,
          clicks: 150,
          conversions: 8,
          platform_attributed_purchase_value: 640,
          platform_attributed_roas: 3.55,
          accounts: [],
        },
        {
          platform: "google",
          name: "Google Ads",
          source: "shopify_marketing",
          spend: 100,
          currency: "AUD",
          mixed_currencies: null,
          impressions: 2200,
          clicks: 60,
          conversions: 4,
          platform_attributed_purchase_value: 320,
          platform_attributed_roas: 3.2,
          accounts: [],
          reported_by: ["Google & YouTube"],
          last_synced_at: "2026-10-28T06:00:00.000Z",
          data_through: "2026-10-28",
        },
      ],
      accounts: [],
      last_successful_sync_at: "2026-10-28T08:55:00.000Z",
      data_through: "2026-10-27",
      freshness_note: "Figures as stored in bizinsights at its last sync with each platform.",
      attribution_note:
        "Purchase value and ROAS are what each ad platform credits to its own ads (its attribution), not the store's revenue. Two platforms can credit the same order: use each platform's own (platforms).",
      shopify_marketing_note: "A platform with source shopify_marketing has no ad account figures in bizinsights: its spend is what its app reported to Shopify.",
    },
    outputFields: [
      { key: "spend", label: "Spend", type: "number" },
      { key: "currency", label: "Currency" },
      { key: "impressions", label: "Impressions", type: "integer" },
      { key: "clicks", label: "Clicks", type: "integer" },
      { key: "conversions", label: "Conversions (as the platforms count them)", type: "number" },
      // Deprecated with Meta and Google both in (claims_add_up false): one platform's claim added to the
      // other's, which can count an order twice. Kept for the Zaps that map them; new ones use platforms.
      { key: "platform_attributed_purchase_value", label: "Purchase value the platforms credit to their ads (deprecated with both platforms: use each platform's)", type: "number" },
      { key: "platform_attributed_roas", label: "ROAS as the platforms credit it (deprecated with both platforms: use each platform's)", type: "number" },
      { key: "claims_add_up", label: "Purchase value and ROAS are one platform's", type: "boolean" },
      { key: "platforms[]platform", label: "Platform" },
      { key: "platforms[]source", label: "Where the platform's figures come from (platform_api or shopify_marketing)" },
      { key: "platforms[]spend", label: "Platform's spend", type: "number" },
      { key: "platforms[]platform_attributed_purchase_value", label: "Purchase value the platform credits to its ads", type: "number" },
      { key: "platforms[]platform_attributed_roas", label: "ROAS as the platform credits it", type: "number" },
      { key: "last_successful_sync_at", label: "Last sync", type: "datetime" },
    ],
  },
};
