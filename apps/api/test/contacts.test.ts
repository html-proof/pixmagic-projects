import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { encryptTokenFields, type FetchLike } from "@app/core";
import { systemDb } from "@app/db";
import { clean, createStore, createWorkspace, setup, signIn, teardown, type TestCtx } from "./helpers.js";
import { LEGACY_GRANTS } from "@app/shared";

/**
 * GET .../contacts: shoppers' contact details, read live from Shopify and never stored.
 */

const SHOP = "contacts-shop.myshopify.com";

let ctx: TestCtx;
beforeAll(async () => (ctx = await setup()));
afterAll(async () => teardown(ctx));
beforeEach(async () => clean(ctx));

async function connectedStore(ws: string, scopes: string[], shop = SHOP) {
  const store = await createStore(ws, shop, scopes);
  await systemDb.store.update({
    where: { id: store.id },
    data: encryptTokenFields(store.id, { accessToken: "shpat_test", scopes, accessTokenExpiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }),
  });
  return store;
}

const reply = (body: unknown): FetchLike => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const jane = {
  id: "gid://shopify/Customer/11",
  displayName: "Jane Doe",
  createdAt: "2026-10-05T09:00:00Z",
  numberOfOrders: "2",
  amountSpent: { amount: "120.50", currencyCode: "AUD" },
  defaultEmailAddress: { emailAddress: "jane@example.com", marketingState: "SUBSCRIBED" },
  defaultPhoneNumber: { phoneNumber: "+61400000000", smsMarketingConsent: { state: "SUBSCRIBED" } },
};
const bob = {
  ...jane,
  id: "gid://shopify/Customer/12",
  displayName: "Bob Lee",
  numberOfOrders: "0",
  amountSpent: { amount: "0.0", currencyCode: "AUD" },
  defaultEmailAddress: { emailAddress: "bob@example.com", marketingState: "NOT_SUBSCRIBED" },
  defaultPhoneNumber: null,
};

const shopifyData = {
  abandonedCheckouts: {
    nodes: [
      {
        id: "gid://shopify/AbandonedCheckout/900",
        createdAt: "2026-10-06T08:00:00Z",
        abandonedCheckoutUrl: "https://contacts-shop.myshopify.com/123/checkouts/abc/recover?key=k",
        totalPriceSet: { shopMoney: { amount: "68.00", currencyCode: "AUD" } },
        lineItems: { nodes: [{ title: "Linen Shirt", quantity: 1 }] },
        customer: bob,
      },
    ],
  },
  // Shopify's accepts_marketing filter is trusted only as far as each row's own state says.
  subscribers: { nodes: [jane, bob] },
  recent: { nodes: [bob, jane] },
};

describe("customer contacts", () => {
  let headers: Record<string, string>;
  let ws: string;

  beforeEach(async () => {
    const u = await signIn(ctx, "uc", "owner@x.com");
    headers = u.headers;
    ws = await createWorkspace(ctx, headers, "C");
  });

  const get = (storeId: string, h = headers, workspace = ws) => ctx.app.inject({ method: "GET", url: `/workspaces/${workspace}/stores/${storeId}/contacts`, headers: h });

  it("returns abandoned checkouts, subscribers and newest customers live from Shopify, and stores none of it", async () => {
    const store = await connectedStore(ws, ["read_orders", "read_customers"]);
    let sent = "";
    ctx.setFetch(async (input, init) => {
      sent = String(init?.body ?? "");
      return reply({ data: shopifyData })(input, init);
    });
    const res = await get(store.id);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(sent).toContain("abandonedCheckouts");
    const body = res.json();
    expect(body.restricted).toBe(false);
    expect(body.abandoned).toEqual([
      {
        id: "900",
        customerId: "12",
        name: "Bob Lee",
        email: "bob@example.com",
        phone: null,
        phoneE164: null,
        phoneRaw: null,
        phoneSource: null,
        phoneCountryAssumed: false,
        subscribed: false,
        smsSubscribed: false,
        adminUrl: `https://${SHOP}/admin/customers/12`,
        createdAt: "2026-10-06T08:00:00Z",
        total: 68,
        currency: "AUD",
        items: [{ title: "Linen Shirt", quantity: 1 }],
        recoveryUrl: "https://contacts-shop.myshopify.com/123/checkouts/abc/recover?key=k",
      },
    ]);
    expect(body.subscribers.map((s: { email: string }) => s.email)).toEqual(["jane@example.com"]);
    expect(body.recent).toHaveLength(2);
    expect(body.recent[1]).toMatchObject({ name: "Jane Doe", orders: 2, spent: 120.5, currency: "AUD", subscribed: true, phone: "+61400000000", phoneE164: "+61400000000", phoneSource: "customer", smsSubscribed: true });

    // Viewing personal data is audited; the data itself is nowhere in our database.
    const log = await systemDb.auditLog.findFirstOrThrow({ where: { workspaceId: ws, action: "customers.contacts_viewed" } });
    expect(log.targetId).toBe(store.id);
    const dump = JSON.stringify(await systemDb.auditLog.findMany());
    expect(dump).not.toContain("jane@example.com");
  });

  it("reaches a guest through the name and phone they typed into the checkout", async () => {
    const store = await connectedStore(ws, ["read_orders", "read_customers"]);
    let sent = "";
    const guest = {
      ...shopifyData.abandonedCheckouts.nodes[0]!,
      id: "gid://shopify/AbandonedCheckout/901",
      customer: null,
      shippingAddress: { firstName: "Ana", lastName: "Ruiz", phone: null },
      billingAddress: { firstName: "Ana", lastName: "Ruiz", phone: " +61411111111 " },
    };
    const withCustomer = {
      ...shopifyData.abandonedCheckouts.nodes[0]!,
      id: "gid://shopify/AbandonedCheckout/902",
      customer: jane,
      shippingAddress: { firstName: "Someone", lastName: "Else", phone: "+61499999999" },
    };
    ctx.setFetch(async (input, init) => {
      sent = String(init?.body ?? "");
      return reply({ data: { ...shopifyData, abandonedCheckouts: { nodes: [guest, withCustomer] } } })(input, init);
    });
    const body = (await get(store.id)).json();
    expect(sent).toContain("shippingAddress");
    expect(body.abandoned[0]).toMatchObject({ id: "901", customerId: null, name: "Ana Ruiz", email: null, phone: "+61411111111", phoneE164: "+61411111111", phoneSource: "checkout_billing", smsSubscribed: false, adminUrl: null });
    // The customer's own details win over whatever was typed into the address.
    expect(body.abandoned[1]).toMatchObject({ name: "Jane Doe", phone: "+61400000000", phoneSource: "customer", smsSubscribed: true });
  });

  describe("a complete phone number for every customer", () => {
    const sentBodies: string[] = [];
    const answer = (data: Record<string, unknown>) =>
      ctx.setFetch(async (input, init) => {
        sentBodies.push(String(init?.body ?? ""));
        return reply({ data: { abandonedCheckouts: { nodes: [] }, subscribers: { nodes: [] }, ...data } })(input, init);
      });
    const customer = (id: number, extra: Record<string, unknown>) => ({ ...bob, id: `gid://shopify/Customer/${id}`, displayName: `Customer ${id}`, ...extra });
    beforeEach(() => {
      sentBodies.length = 0;
    });

    it("asks Shopify for every place a number can be, with each address's country and the store's", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      answer({ recent: { nodes: [] } });
      expect((await get(store.id)).statusCode).toBe(200);
      const query = JSON.parse(sentBodies.at(-1)!).query as string;
      for (const field of ["defaultPhoneNumber", "defaultAddress", "lastOrder", "countryCodeV2", "shopAddress"]) expect(query).toContain(field);
      // Both of the checkout's addresses carry their country too.
      expect(query).toMatch(/shippingAddress \{ firstName lastName phone countryCodeV2 \}/);
      expect(query).toMatch(/billingAddress \{ firstName lastName phone countryCodeV2 \}/);
    });

    it("turns a local number into an international one with the customer's address country", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      const local = customer(21, {
        defaultPhoneNumber: { phoneNumber: "0412 345 678", smsMarketingConsent: { state: "SUBSCRIBED" } },
        defaultAddress: { phone: null, countryCodeV2: "AU" },
      });
      answer({ recent: { nodes: [local] } });
      const body = (await get(store.id)).json();
      expect(body.recent[0]).toMatchObject({
        phone: "+61412345678",
        phoneE164: "+61412345678",
        phoneRaw: "0412 345 678",
        phoneSource: "customer",
        phoneCountryAssumed: false,
        smsSubscribed: true,
      });
    });

    it("finds the number on the last order's delivery address when the profile has none", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      const ordered = customer(22, {
        defaultPhoneNumber: null,
        defaultAddress: { phone: null, countryCodeV2: "NZ" },
        lastOrder: { phone: null, shippingAddress: { phone: "021 555 0123", countryCodeV2: "NZ" }, billingAddress: null },
      });
      // A guest's checkout: the number typed into its delivery address, read with that address's country.
      const guest = {
        ...shopifyData.abandonedCheckouts.nodes[0]!,
        id: "gid://shopify/AbandonedCheckout/903",
        customer: null,
        shippingAddress: { firstName: "Ana", lastName: "Ruiz", phone: "0412 345 678", countryCodeV2: "AU" },
        billingAddress: null,
      };
      answer({ recent: { nodes: [ordered] }, abandonedCheckouts: { nodes: [guest] } });
      const body = (await get(store.id)).json();
      expect(body.recent[0]).toMatchObject({ phone: "+64215550123", phoneE164: "+64215550123", phoneRaw: "021 555 0123", phoneSource: "last_order_shipping", smsSubscribed: false });
      expect(body.abandoned[0]).toMatchObject({ name: "Ana Ruiz", phone: "+61412345678", phoneSource: "checkout_shipping", phoneCountryAssumed: false });
    });

    it("adds the store's country code only when nothing else gives one, and says so", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      const noCountry = customer(23, { defaultPhoneNumber: { phoneNumber: "0433 333 333", smsMarketingConsent: { state: "NOT_SUBSCRIBED" } } });
      answer({ recent: { nodes: [noCountry] }, shop: { shopAddress: { countryCodeV2: "AU" } } });
      const fromShop = (await get(store.id)).json();
      expect(fromShop.recent[0]).toMatchObject({ phone: "+61433333333", phoneE164: "+61433333333", phoneRaw: "0433 333 333", phoneSource: "customer", phoneCountryAssumed: true });

      // No Shopify address country either: the country chosen in Customer Messaging's setup.
      await systemDb.smsSetup.create({ data: { workspaceId: ws, storeId: store.id, country: "AU" } });
      answer({ recent: { nodes: [noCountry] } });
      const fromSetup = (await get(store.id)).json();
      expect(fromSetup.recent[0]).toMatchObject({ phoneE164: "+61433333333", phoneCountryAssumed: true });
    });

    it("shows a number it can't read as typed, with no international form, and never guesses a country", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      const unreadable = customer(24, { defaultPhoneNumber: { phoneNumber: " 0412 345 678 ", smsMarketingConsent: { state: "SUBSCRIBED" } } });
      answer({ recent: { nodes: [unreadable] } });
      const body = (await get(store.id)).json();
      expect(body.recent[0]).toMatchObject({ phone: "0412 345 678", phoneE164: null, phoneRaw: "0412 345 678", phoneSource: "customer", phoneCountryAssumed: false, smsSubscribed: true });
    });

    it("keeps text-message consent to the profile's own number", async () => {
      const store = await connectedStore(ws, ["read_orders", "read_customers"]);
      // The profile's number can't be read; the last order's can. Its consent isn't the profile's.
      const other = customer(25, {
        defaultPhoneNumber: { phoneNumber: "555 0100", smsMarketingConsent: { state: "SUBSCRIBED" } },
        lastOrder: { phone: "+61455555555", shippingAddress: null, billingAddress: null },
      });
      answer({ recent: { nodes: [other] } });
      const body = (await get(store.id)).json();
      expect(body.recent[0]).toMatchObject({ phone: "+61455555555", phoneSource: "last_order", smsSubscribed: false });
    });
  });

  it("says when Shopify withholds contact details instead of showing an empty list", async () => {
    const store = await connectedStore(ws, ["read_orders", "read_customers"]);
    const withheld = { ...bob, displayName: null, defaultEmailAddress: null, defaultPhoneNumber: null };
    ctx.setFetch(
      reply({
        data: { abandonedCheckouts: { nodes: [] }, subscribers: { nodes: [] }, recent: { nodes: [withheld] } },
        errors: [{ message: "Access denied for email field", extensions: { code: "ACCESS_DENIED" } }],
      }),
    );
    const res = await get(store.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ restricted: true, abandoned: [], subscribers: [], recent: [] });
  });

  it("needs the customers permission, the scopes, a connected store and the right workspace", async () => {
    ctx.setFetch(reply({ data: shopifyData }));
    const noScope = await connectedStore(ws, ["read_orders"], "a.myshopify.com");
    expect((await get(noScope.id)).json().error).toBe("missing_scopes");

    const notConnected = await createStore(ws, "b.myshopify.com", ["read_orders", "read_customers"]);
    expect((await get(notConnected.id)).statusCode).toBe(409);

    const store = await connectedStore(ws, ["read_orders", "read_customers"]);
    const other = await signIn(ctx, "uo", "other@x.com");
    const otherWs = await createWorkspace(ctx, other.headers, "O");
    expect((await get(store.id, other.headers, otherWs)).statusCode).toBe(404);

    // Viewers see the dashboard but not shoppers' personal details.
    const me = await systemDb.user.findFirstOrThrow({ where: { email: "owner@x.com" } });
    await systemDb.membership.update({ where: { workspaceId_userId: { workspaceId: ws, userId: me.id } }, data: { role: "viewer", permissions: [...LEGACY_GRANTS.viewer] } });
    expect((await get(store.id)).statusCode).toBe(403);
  });
});
