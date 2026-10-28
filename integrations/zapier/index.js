// bizinsights on Zapier (docs/zapier.md): the store's alerts, advertising thresholds, daily
// advertising summary and failed WhatsApp messages as instant triggers (REST hooks), two searches
// over its stored advertising figures, and one action: send a customer a WhatsApp template Meta
// approved, for a connection allowed to (ticked on bizinsights' page). Nothing else in bizinsights is
// changed from Zapier.
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
  // Hidden: the action's template dropdown.
  require("./triggers/whatsappTemplates"),
];
const searches = [require("./searches/findAdPerformance"), require("./searches/findAdsenseEarnings")];
const creates = [require("./creates/sendWhatsappTemplate")];

const byKey = (items) => Object.fromEntries(items.map((i) => [i.key, i]));

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [includeBearerToken],
  afterResponse: [handleErrors],
  triggers: byKey(triggers),
  searches: byKey(searches),
  creates: byKey(creates),
  resources: {},
};
