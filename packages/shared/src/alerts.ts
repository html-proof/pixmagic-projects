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
export type AlertArea = "shopify" | "email" | "staff" | "whatsapp" | "privacy" | "general";

/** The app page each area's alerts link to (a path: the email puts APP_URL in front of it). */
export const ALERT_PATH: Record<AlertArea, string> = {
  shopify: "/settings/stores",
  email: "/settings/email/accounts",
  staff: "/staff/timesheets",
  whatsapp: "/whatsapp/automations",
  privacy: "/settings/privacy",
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
  // These messages are composed from the app's wording and the merchant's own addresses and counts.
  if (code.startsWith("email_account_reauth:")) return { severity, area: "email", title: "An email account needs reconnecting", body: message };
  if (code.startsWith("email_sender_rejected:")) return { severity, area: "email", title: "A sender address was refused", body: message };
  if (code === "staff_open_shifts") return { severity, area: "staff", title: "Shifts left open", body: message };
  // The text a merchant wrote in a WhatsApp automation's "notify the team" step.
  if (code.startsWith("wa_rule_")) return { severity, area: "whatsapp", title: "WhatsApp automation", body: message };
  return { severity, area: "general", title: "Something needs your attention", body: "If this keeps showing, contact support and we'll look into it." };
}
