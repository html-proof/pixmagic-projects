// What a workspace alert says to a merchant (the bell in the app's top bar, and the alert email).
//
// Alerts are raised with a code and an internal message (core's raiseAlert). That message is for
// the logs only: for sync and webhook failures it ends with the error's own text, which can carry
// database or provider internals. So the app words every alert from its code, and passes the stored
// message on only for codes whose message is built from the app's own wording and the merchant's
// own data (marked where they are raised). An unknown code gets generic wording.
//
// Imported by the UI through `@app/shared/alerts`: no I/O, no node: imports.

export type AlertSeverity = "info" | "warning" | "critical";

/** Where the problem gets fixed: the bell and the alert email link each to its page. */
export type AlertArea = "shopify" | "ads" | "email" | "staff" | "whatsapp" | "sms" | "privacy" | "inventory" | "general";

/** The app page each area's alerts link to (a path: the email puts APP_URL in front of it). */
export const ALERT_PATH: Record<AlertArea, string> = {
  shopify: "/settings/stores",
  ads: "/settings/ads",
  email: "/settings/email/accounts",
  staff: "/staff/timesheets",
  whatsapp: "/whatsapp",
  sms: "/messaging/billing",
  privacy: "/settings/privacy",
  inventory: "/inventory/low-stock",
  general: "/support",
};

/** One alert as the app's API sends it: never the raw code or message. */
export interface AlertView {
  id: string;
  severity: AlertSeverity;
  area: AlertArea;
  title: string;
  body: string;
  /** The store it is about, if any. */
  store: { id: string; name: string } | null;
  createdAt: string;
}

export interface AlertWording {
  severity: AlertSeverity;
  area: AlertArea;
  title: string;
  body: string;
}

const SEVERITIES: readonly string[] = ["info", "warning", "critical"] satisfies AlertSeverity[];

/** What each sync kind (core's SyncKind) brings in, for "Couldn't sync …". */
const SYNC_WHAT: Record<string, string> = {
  shop: "your store details",
  products: "your products",
  variants: "your product variants",
  orders: "your orders",
  inventory: "your stock levels",
};

const STILL_CORRECT = "The figures you already see are still correct, and the next scheduled sync will try again.";

/** Shopify approves an app's access to protected customer data (orders carry customer details) before it may read them on merchants' stores. */
const NOT_APPROVED_BODY =
  "Shopify has to approve an app before it can read orders, which hold customer details, on merchants' stores, and bizinsights is still waiting on that approval. There's nothing to do on your side, and reconnecting won't change it: your orders import by themselves once Shopify approves.";

function syncWording(kind: string, outcome: "failed" | "stalled" | "not_approved", severity: AlertSeverity): Omit<AlertWording, "severity"> {
  if (outcome === "not_approved") return { area: "shopify", title: `Shopify hasn't approved bizinsights to read ${SYNC_WHAT[kind] ?? "your store data"} yet`, body: NOT_APPROVED_BODY };
  if (kind === "install_pixel") {
    return {
      area: "shopify",
      title: "Visitor tracking isn't set up",
      body: "We couldn't add the bizinsights pixel to your store, so visits and the shopping funnel aren't being counted. Reconnecting the store in Settings → Shopify usually fixes this.",
    };
  }
  const what = SYNC_WHAT[kind] ?? "your store data";
  if (outcome === "stalled") return { area: "shopify", title: `Syncing ${what} didn't finish`, body: `It stopped part-way and nothing newer has completed yet. ${STILL_CORRECT}` };
  return {
    area: "shopify",
    title: `Couldn't sync ${what}`,
    body:
      severity === "critical"
        ? "This store's data has stopped updating. Reconnect it in Settings → Shopify, and contact support if that doesn't help."
        : `We tried several times and stopped for now. ${STILL_CORRECT}`,
  };
}

/** An ad account's alerts (core's adConnections/alerts.ts): one per kind and connection, `ads_<kind>:<connection id>`. */
const ADS_TITLE: Record<string, string> = {
  reconnect: "An ad account needs reconnecting",
  expiring: "Meta access ends soon",
  failing: "An ad account stopped updating",
  unavailable: "An ad account isn't available",
};

/** The merchant-facing wording of an alert, from its code (and, for safe codes only, its message). */
export function describeAlert(alert: { code: string; severity: string; message: string }): AlertWording {
  const severity = (SEVERITIES.includes(alert.severity) ? alert.severity : "warning") as AlertSeverity;
  const { code, message } = alert;

  const sync = /^sync_(.+)_(failed|stalled|not_approved)$/.exec(code);
  if (sync) return { severity, ...syncWording(sync[1]!, sync[2] as "failed" | "stalled" | "not_approved", severity) };
  if (code === "webhook_failed") {
    return {
      severity,
      area: "shopify",
      title: "An update from Shopify couldn't be processed",
      body: "A recent change in your store, such as a new order or a refund, may be missing for now. The daily check with Shopify picks up recent orders it missed.",
    };
  }
  if (code === "reconciliation_mismatch") {
    return {
      severity,
      area: "shopify",
      title: "Some figures differ from Shopify's",
      body: "The daily check against your Shopify orders found figures it couldn't match or repair. The dashboard shows which under About this data; the next check runs tomorrow, and support can look into it if this stays.",
    };
  }
  if (code === "privacy_request") {
    return {
      severity,
      area: "privacy",
      title: "A customer asked for their data",
      body: "They asked through Shopify for the data bizinsights holds about them. Download it from Settings → Privacy requests and send it to them: Shopify gives 30 days to answer.",
    };
  }
  // These messages are composed from the app's wording and the merchant's own addresses and counts
  // (an ad account's: its name and the wording of its error code, adErrorMessage in ./ads).
  const ads = /^ads_(reconnect|expiring|failing|unavailable):/.exec(code);
  if (ads) return { severity, area: "ads", title: ADS_TITLE[ads[1]!]!, body: message || "Open Settings → Advertising to see what it needs." };
  if (code.startsWith("email_account_reauth:")) return { severity, area: "email", title: "An email account needs reconnecting", body: message };
  if (code.startsWith("email_sender_rejected:")) return { severity, area: "email", title: "A sender address was refused", body: message };
  // Composed from the app's wording and the store's own counts (core's inventory alerts).
  if (code === "inventory_stock") return { severity, area: "inventory", title: "Stock is running low", body: message };
  if (code === "staff_open_shifts") return { severity, area: "staff", title: "Shifts left open", body: message };
  // WhatsApp Automation (core whatsapp/tokens.ts): worded here from the code alone.
  if (code === "wa_reconnect") {
    return {
      severity,
      area: "whatsapp",
      title: "Reconnect WhatsApp",
      body: "Meta no longer accepts bizinsights' access to your WhatsApp number, so nothing is being sent. Open WhatsApp Automation and press Reconnect: messages waiting are sent if you reconnect within 48 hours.",
    };
  }
  if (code === "wa_account") {
    return {
      severity,
      area: "whatsapp",
      title: "Your WhatsApp account needs attention",
      body: "Meta reported a problem with your WhatsApp Business account, such as a restriction or a missing payment method. Open WhatsApp Automation to see what it says, then fix it in WhatsApp Manager.",
    };
  }
  if (code === "wa_webhook_failed") {
    return { severity, area: "whatsapp", title: "Some WhatsApp updates couldn't be applied", body: "Delivery reports or replies from WhatsApp couldn't be processed, so some statuses may be out of date. Contact bizinsights support if this keeps happening." };
  }
  // Customer Messaging (core/sms): worded here from the code alone.
  const budget = /^sms_budget_(50|80|100)$/.exec(code);
  if (budget) {
    const pct = budget[1]!;
    return {
      severity,
      area: "sms",
      title: pct === "100" ? "Your SMS budget for this month is used up" : `You've used ${pct}% of this month's SMS budget`,
      body:
        pct === "100"
          ? "Texts that would go over the budget aren't sent while its hard stop is on. Raise the budget in Customer Messaging → SMS billing, or wait for next month."
          : "Customer Messaging → SMS billing shows what was spent, by country and campaign, from what AWS charged for each text.",
    };
  }
  if (code === "sms_sender_problem") {
    return { severity, area: "sms", title: "Your SMS sender needs attention", body: "AWS refused the sender this store texts from, so texts are on hold. Customer Messaging → Sender configuration shows what AWS reported." };
  }
  if (code === "sms_account_limit") {
    return { severity, area: "sms", title: "Texts are on hold: the SMS spending limit is reached", body: "The account's monthly SMS spending limit is reached, so texts wait until it is raised or the month ends. Contact support if this stays." };
  }
  return { severity, area: "general", title: "Something needs your attention", body: "If this keeps showing, contact support and we'll look into it." };
}
