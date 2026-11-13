// What a workspace alert says to a merchant (the bell in the app's top bar, and the alert email).
//
// Alerts are raised with a code and an internal message (core's raiseAlert). That message is for
// the logs only: for sync and webhook failures it ends with the error's own text, which can carry
// database or provider internals. So the app words every alert from its code, and passes the stored
// message on only for codes whose message is built from the app's own wording and the merchant's
// own data (marked where they are raised). An unknown code gets generic wording.
//
// Imported by the UI through `@app/shared/alerts`: no I/O, no node: imports.

import { allows, hasFullAccess, type MemberAccess } from "./access";
import { staffAccess, staffCan, type StaffRole } from "./staff/access";

export type AlertSeverity = "info" | "warning" | "critical";

/** Where the problem gets fixed: the bell and the alert email link each to its page. */
export type AlertArea = "shopify" | "ads" | "staff" | "whatsapp" | "privacy" | "inventory" | "integrations" | "general";

/** The app page each area's alerts link to (a path: the email puts APP_URL in front of it). */
export const ALERT_PATH: Record<AlertArea, string> = {
  shopify: "/settings/stores",
  ads: "/settings/ads",
  integrations: "/settings/integrations",
  staff: "/staff/timesheets",
  whatsapp: "/dashboard/whatsapp-automation",
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
  // Composed from the app's wording and the store's own counts (core's inventory alerts).
  if (code === "inventory_stock") return { severity, area: "inventory", title: "Stock is running low", body: message };
  if (code === "staff_open_shifts") return { severity, area: "staff", title: "Shifts left open", body: message };
  // WhatsApp Automation (core whatsapp/connection.ts and sweep.ts): worded here from the code alone.
  if (code === "whatsapp_logged_out") {
    return {
      severity,
      area: "whatsapp",
      title: "Link WhatsApp again",
      body: "WhatsApp logged out the phone linked to bizinsights (it was unlinked on the phone, or WhatsApp ended the session), so nothing is being sent. Open WhatsApp Automation and link it again: messages waiting are sent if you do within 48 hours.",
    };
  }
  if (code === "whatsapp_disconnected") {
    return { severity, area: "whatsapp", title: "WhatsApp has been disconnected for 2 days", body: "The messages that were waiting to go were cancelled. Open WhatsApp Automation to connect it again." };
  }
  if (code === "whatsapp_provider_down") {
    return { severity, area: "whatsapp", title: "WhatsApp messages are waiting", body: "bizinsights' WhatsApp service isn't answering, so messages wait and are sent once it is back. Nothing needs doing; contact bizinsights support if this lasts." };
  }
  // Raised on 2026-10-28, while QR linking was switched off for a day; resolved when the store links a phone again.
  if (code === "whatsapp_qr_retired") {
    return {
      severity,
      area: "whatsapp",
      title: "Link your WhatsApp phone again",
      body: "QR-code linking was switched off for a day, so your linked phone was disconnected, the messages waiting were cancelled (none was sent) and your automations were paused. QR-code linking is back: open WhatsApp Automation, link the phone again, then turn your automations back on.",
    };
  }
  // Zapier (core zapier/delivery.ts): an event Zapier never took, after its tries. Worded from the code alone.
  if (code === "zapier_delivery_failed") {
    return {
      severity,
      area: "integrations",
      title: "Some events didn't reach Zapier",
      body: "Zapier refused one of this store's events, or didn't answer after several tries, so the Zap waiting for it didn't run. Settings → Integrations → Zapier shows which and why; an owner or admin can send it again with Retry.",
    };
  }
  return { severity, area: "general", title: "Something needs your attention", body: "If this keeps showing, contact support and we'll look into it." };
}

/**
 * Whether a member may see (and fix) an alert of this area: the bell's rule (GET .../alerts), which
 * Zapier's "New alert" trigger follows for the person who connected it. Settings → Privacy requests
 * needs audit:read; Settings → Advertising, "Manage integrations"; WhatsApp, "View campaigns"; the
 * Shopify connection, Zapier's undelivered events (Retry is theirs) and the help page's alerts go to
 * owners and admins.
 */
export function mayFixAlert(area: AlertArea, access: MemberAccess, staffRole: StaffRole | null): boolean {
  switch (area) {
    case "staff":
      return staffCan(staffAccess(access.role, staffRole, access.permissions), "attendance:view");
    case "privacy":
      return allows(access, "audit:read");
    case "whatsapp":
      return allows(access, "marketing.campaigns");
    case "ads":
      return allows(access, "integrations.manage");
    default:
      return hasFullAccess(access.role);
  }
}
