const { apiUrl } = require("../lib/api");

// The store's estimated AdSense earnings for chosen dates, as stored in bizinsights. Empty without an
// AdSense account connected.
module.exports = {
  key: "find_adsense_earnings",
  noun: "AdSense Earnings",
  display: {
    label: "Find AdSense Earnings",
    description: "Finds the store's estimated Google AdSense earnings, page views and clicks for the dates you choose, as stored in bizinsights.",
  },
  operation: {
    inputFields: [
      { key: "since", label: "From", type: "datetime", helpText: "The first day (the store's calendar). Empty: 7 days before To." },
      { key: "until", label: "To", type: "datetime", helpText: "The last day. Empty: yesterday." },
    ],
    perform: async (z, bundle) => {
      const params = {};
      if (bundle.inputData.since) params.since = String(bundle.inputData.since).slice(0, 10);
      if (bundle.inputData.until) params.until = String(bundle.inputData.until).slice(0, 10);
      return (await z.request({ url: apiUrl("/zapier/search/adsense-earnings"), params })).data;
    },
    sample: {
      id: "adsense_earnings:store_example:2026-10-21:2026-10-27",
      since: "2026-10-21",
      until: "2026-10-27",
      earnings_estimated: 84.3,
      currency: "AUD",
      mixed_currencies: null,
      page_views: 12000,
      impressions: 30000,
      clicks: 140,
      accounts: [],
      last_successful_sync_at: "2026-10-28T08:55:00.000Z",
      data_through: "2026-10-27",
      estimates_note: "AdSense earnings are Google's estimates: Google can adjust them, and finalizes a month's earnings after it ends.",
    },
    outputFields: [
      { key: "earnings_estimated", label: "Estimated earnings", type: "number" },
      { key: "currency", label: "Currency" },
      { key: "page_views", label: "Page views", type: "integer" },
      { key: "clicks", label: "Clicks", type: "integer" },
      { key: "estimates_note", label: "About the estimates" },
    ],
  },
};
