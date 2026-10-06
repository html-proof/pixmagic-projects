import { withTenant } from "@app/db";
import { audit, env, getAccessToken, logger, ShopifyGraphqlError, ShopifyHttpError, shopifyGraphql, StoreDisconnectedError } from "@app/core";
import { hasCapability } from "@app/shared";
import { clientIp, HttpError, requireWorkspace, type Deps } from "../context.js";
import type { App } from "../app.js";
import { limit } from "../rateLimit.js";

/**
 * Customers a merchant can get back in touch with: shoppers who gave an email at checkout and
 * didn't finish, newsletter sign-ups, and the newest customers.
 *
 * Read live from Shopify on every request and NEVER written to our database: names, emails and
 * phone numbers pass through to the merchant's browser and nowhere else. That keeps the
 * "we store no customer personal data" promise on /privacy true, and leaves customer redaction
 * entirely to Shopify. On a live store Shopify returns these fields only once the app is
 * approved for protected customer data (Level 2: name, email, phone); until then they come back
 * withheld and the response says `restricted`.
 */

const PAGE = 25;

const CUSTOMER_FIELDS = `
  id
  displayName
  createdAt
  numberOfOrders
  amountSpent { amount currencyCode }
  defaultEmailAddress { emailAddress marketingState }
  defaultPhoneNumber { phoneNumber }`;

const CONTACTS_QUERY = `#graphql
  query Contacts($first: Int!) {
    abandonedCheckouts(first: $first, sortKey: CREATED_AT, reverse: true, query: "status:open") {
      nodes {
        id
        createdAt
        abandonedCheckoutUrl
        totalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 3) { nodes { title quantity } }
        customer { ${CUSTOMER_FIELDS} }
      }
    }
    subscribers: customers(first: $first, sortKey: CREATED_AT, reverse: true, query: "accepts_marketing:true") {
      nodes { ${CUSTOMER_FIELDS} }
    }
    recent: customers(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes { ${CUSTOMER_FIELDS} }
    }
  }`;

interface GqlCustomer {
  id: string;
  displayName: string | null;
  createdAt: string;
  numberOfOrders: string | number | null;
  amountSpent: { amount: string; currencyCode: string } | null;
  defaultEmailAddress: { emailAddress: string | null; marketingState: string | null } | null;
  defaultPhoneNumber: { phoneNumber: string | null } | null;
}

interface GqlContacts {
  abandonedCheckouts: {
    nodes: Array<{
      id: string;
      createdAt: string;
      abandonedCheckoutUrl: string;
      totalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
      lineItems: { nodes: Array<{ title: string; quantity: number }> } | null;
      customer: GqlCustomer | null;
    }>;
  } | null;
  subscribers: { nodes: Array<GqlCustomer | null> } | null;
  recent: { nodes: Array<GqlCustomer | null> } | null;
}

/** "gid://shopify/Customer/123" → "123". */
const numericId = (gid: string) => gid.split("/").pop() ?? gid;

function person(c: GqlCustomer | null, shopDomain: string) {
  return {
    customerId: c ? numericId(c.id) : null,
    name: c?.displayName?.trim() || null,
    email: c?.defaultEmailAddress?.emailAddress ?? null,
    phone: c?.defaultPhoneNumber?.phoneNumber ?? null,
    subscribed: c?.defaultEmailAddress?.marketingState === "SUBSCRIBED",
    adminUrl: c ? `https://${shopDomain}/admin/customers/${encodeURIComponent(numericId(c.id))}` : null,
  };
}

function customerRow(c: GqlCustomer, shopDomain: string) {
  return {
    ...person(c, shopDomain),
    createdAt: c.createdAt,
    orders: Number(c.numberOfOrders ?? 0),
    spent: Number(c.amountSpent?.amount ?? 0),
    currency: c.amountSpent?.currencyCode ?? null,
  };
}

export function contactRoutes(app: App, deps: Deps) {
  app.get("/workspaces/:ws/stores/:storeId/contacts", async (c) => {
    const { ws, storeId } = c.req.param();
    const access = await requireWorkspace(c, deps, ws, "customers:contact");
    await limit(deps.coord, `rl:contacts:${ws}:${access.user?.id ?? clientIp(c)}`, 20, 60);
    // Personal data: never let a browser or proxy keep a copy.
    c.header("cache-control", "no-store");

    const store = await withTenant(ws, (tx) => tx.store.findFirst({ where: { id: storeId, workspaceId: ws } }));
    if (!store || store.status === "uninstalled") throw new HttpError(404, "Not found", "not_found");
    if (!hasCapability(store.grantedScopes, "contacts")) {
      throw new HttpError(403, "Insights needs access to your customers first.", "missing_scopes");
    }

    let data: GqlContacts;
    let restricted = false;
    try {
      const token = await getAccessToken(store, deps.coord, deps.fetchImpl);
      data = await shopifyGraphql<GqlContacts>({
        shop: store.shopDomain,
        accessToken: token,
        apiVersion: env().SHOPIFY_API_VERSION,
        query: CONTACTS_QUERY,
        variables: { first: PAGE },
        fetchImpl: deps.fetchImpl,
        maxRetries: 2,
      });
    } catch (err) {
      if (err instanceof StoreDisconnectedError) throw new HttpError(409, "This store isn't connected any more. Reconnect it to see customers.", "store_disconnected");
      if (err instanceof ShopifyHttpError && (err.status === 401 || err.status === 403)) {
        throw new HttpError(409, "Shopify stopped accepting our access. Reconnect the store to see customers.", "store_disconnected");
      }
      if (err instanceof ShopifyGraphqlError && err.codes.includes("ACCESS_DENIED")) {
        restricted = true;
        data = { abandonedCheckouts: null, subscribers: null, recent: null };
      } else {
        logger.warn({ err, storeId }, "contacts fetch failed");
        throw new HttpError(502, "Shopify didn't answer just now. Please try again in a moment.", "shopify_unavailable");
      }
    }

    const abandoned = (data.abandonedCheckouts?.nodes ?? []).map((a) => {
      const items = a.lineItems?.nodes ?? [];
      return {
        id: numericId(a.id),
        ...person(a.customer, store.shopDomain),
        createdAt: a.createdAt,
        total: Number(a.totalPriceSet?.shopMoney.amount ?? 0),
        currency: a.totalPriceSet?.shopMoney.currencyCode ?? store.currency,
        items: items.map((i) => ({ title: i.title, quantity: i.quantity })),
        recoveryUrl: a.abandonedCheckoutUrl,
      };
    });
    const rows = (list: { nodes: Array<GqlCustomer | null> } | null) =>
      (list?.nodes ?? []).filter((n): n is GqlCustomer => n !== null).map((n) => customerRow(n, store.shopDomain));
    const subscribers = rows(data.subscribers).filter((s) => s.subscribed);
    const recent = rows(data.recent);

    // Shopify withholds unapproved fields as nulls next to otherwise valid data (see
    // shopifyGraphqlWithCost). Rows that came back with no way at all to reach the person mean
    // the store hasn't approved this app for contact details, not that nobody left any.
    // A whole list withheld comes back as null, which a real answer never is.
    const all = [...abandoned, ...recent];
    if (all.length > 0 && all.every((p) => !p.email && !p.phone && !p.name)) restricted = true;
    if (!data.abandonedCheckouts || !data.recent || !data.subscribers) restricted = true;

    await audit({
      workspaceId: ws,
      actorUserId: access.user?.id ?? null,
      action: "customers.contacts_viewed",
      targetType: "store",
      targetId: store.id,
      ip: clientIp(c),
    }).catch((err: unknown) => logger.warn({ err }, "audit failed"));

    return c.json({
      fetchedAt: new Date().toISOString(),
      restricted,
      abandoned: restricted ? [] : abandoned,
      subscribers: restricted ? [] : subscribers,
      recent: restricted ? [] : recent,
    });
  });
}
