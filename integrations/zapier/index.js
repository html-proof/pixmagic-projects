// bizinsights on Zapier (docs/zapier.md): the store's alerts, advertising thresholds, daily
// advertising summary, failed WhatsApp messages, integrations connected or disconnected, ad accounts
// synced and paid orders as instant triggers (REST hooks), and two searches over its stored
// advertising figures. No action: nothing in bizinsights is changed from Zapier, and nothing is sent
// to customers.
const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");
const authentication = require("./authentication");
const { handleErrors, includeBearerToken } = require("./lib/api");

const triggers = [
  require("./triggers/alertRaised"),
  require("./triggers/adSpendThreshold"),
  require("./triggers/adsenseEarningsThreshold"),
  require("./triggers/adsDailySummary"),
  require("./triggers/whatsappMessageFailed"),
  require("./triggers/integrationConnected"),
  require("./triggers/integrationDisconnected"),
  require("./triggers/syncCompleted"),
  require("./triggers/orderPaid"),
];
const searches = [require("./searches/findAdPerformance"), require("./searches/findAdsenseEarnings")];

const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [includeBearerToken],
  afterResponse: [handleErrors],
  triggers: byKey(triggers),
  searches: byKey(searches),
  creates: {},
  resources: {},
};
