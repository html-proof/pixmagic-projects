import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCESS_CAPABILITY,
  ACCESS_KEYS,
  ACCESS_PERMISSIONS,
  accessAvailable,
  addPermission,
  allows,
  linkSessionAccess,
  checkGrants,
  grantedKeys,
  LEGACY_GRANTS,
  modulesOf,
  redactContact,
  redactOverview,
  removePermission,
  RESTRICTED_ROLES,
  ROLE_TEMPLATES,
  seesModule,
  type MemberAccess,
} from "../src/access";
import { CAPABILITIES, resolveCapabilities } from "../src/capabilities";
import { can } from "../src/roles";
import { MONTH_LINES } from "../src/sales";
import { staffAccess } from "../src/staff/access";

const member = (permissions: string[], role: MemberAccess["role"] = "custom"): MemberAccess => ({ role, permissions });

describe("the permission catalog", () => {
  it("lists every key once, each requirement is a key of the catalog, and nothing requires itself", () => {
    expect(new Set(ACCESS_PERMISSIONS.map((p) => p.key)).size).toBe(ACCESS_PERMISSIONS.length);
    expect(ACCESS_PERMISSIONS.map((p) => p.key).sort()).toEqual([...ACCESS_KEYS].sort());
    for (const p of ACCESS_PERMISSIONS) for (const r of p.requires ?? []) expect(ACCESS_KEYS, p.key).toContain(r);
    for (const p of ACCESS_PERMISSIONS) expect(p.requires ?? []).not.toContain(p.key);
  });

  it("marks customers' personal data, finance, payroll, management and exports as sensitive", () => {
    const sensitive = ACCESS_PERMISSIONS.filter((p) => p.sensitive).map((p) => p.key);
    for (const k of ["customers.profiles", "customers.contact", "finance.breakdown", "finance.refunds", "finance.reports", "staff.payroll", "integrations.manage", "staff.manage", "reports.export", "products.prices"]) {
      expect(sensitive).toContain(k);
    }
    for (const p of ACCESS_PERMISSIONS.filter((x) => x.kind !== "view")) expect(p.sensitive, p.key).toBe(true);
  });

  it("role templates are valid for their role and never tick anything sensitive", () => {
    for (const role of RESTRICTED_ROLES) {
      const t = ROLE_TEMPLATES[role];
      expect(checkGrants(role, t), role).toEqual({ ok: true, keys: ACCESS_KEYS.filter((k) => t.includes(k)) });
      for (const k of t) expect(ACCESS_PERMISSIONS.find((p) => p.key === k)!.sensitive, `${role}: ${k}`).toBeFalsy();
    }
    expect(ROLE_TEMPLATES.custom).toEqual([]);
  });

  it("the legacy grants are exactly what migration 20261016180000 gave existing analysts and viewers", () => {
    const sql = readFileSync(resolve(import.meta.dirname, "../../db/prisma/migrations/20261016180000_team_access/migration.sql"), "utf8");
    const arrayFor = (table: string, role: string) => {
      const m = new RegExp(`UPDATE "${table}" SET "permissions" = ARRAY\\[([^\\]]*)\\]::TEXT\\[\\] WHERE "role" = '${role}'`).exec(sql);
      return m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    };
    for (const role of ["viewer", "analyst"] as const) {
      expect(arrayFor("memberships", role)).toEqual([...LEGACY_GRANTS[role]]);
      expect(arrayFor("invitations", role)).toEqual([...LEGACY_GRANTS[role]]);
      expect(checkGrants(role, LEGACY_GRANTS[role]).ok).toBe(true);
    }
  });
});

describe("what each permission shows (the invite panel's \"shows nothing for now\")", () => {
  // The capability ids a store with these scopes has, as GET .../team/catalog reads them.
  const enabled = (scopes: string[], pixelInstalled = false) => new Set(resolveCapabilities(scopes, { pixelInstalled }).filter((c) => c.enabled).map((c) => c.id));

  it("names only store data the capability registry knows", () => {
    const ids = new Set<string>(CAPABILITIES.map((c) => c.id));
    for (const [key, data] of Object.entries(ACCESS_CAPABILITY)) for (const id of typeof data === "string" ? [data] : data) expect(ids.has(id), `${key}: ${id}`).toBe(true);
  });

  it("checkout abandonment shows Shopify's abandoned checkouts with orders alone, without customers", () => {
    expect(accessAvailable("analytics.abandonment", enabled(["read_orders", "read_products"]))).toBe(true);
    // The customer lists (who left a checkout) still need customers.
    expect(accessAvailable("customers.contact", enabled(["read_orders", "read_products"]))).toBe(false);
    expect(accessAvailable("analytics.abandonment", enabled(["read_products"]))).toBe(false);
  });

  it("conversion shows the pixel's funnel or Shopify's own sessions, either one", () => {
    expect(accessAvailable("analytics.conversion", enabled(["read_orders"]))).toBe(false);
    expect(accessAvailable("analytics.conversion", enabled(["read_orders", "read_reports"]))).toBe(true);
    expect(accessAvailable("analytics.conversion", enabled(["read_orders", "write_pixels", "read_customer_events"], true))).toBe(true);
  });

  it("a permission with no store data of its own always shows something", () => {
    expect(accessAvailable("staff.team", new Set())).toBe(true);
  });
});

describe("checkGrants", () => {
  it("refuses unknown keys, a permission without the one it sits inside, and management on viewers and analysts", () => {
    expect(checkGrants("custom", ["nope"])).toMatchObject({ ok: false, problem: { code: "unknown_permission" } });
    expect(checkGrants("custom", ["customers.contact"])).toMatchObject({ ok: false, problem: { code: "missing_requirement", requires: "customers.list" } });
    expect(checkGrants("viewer", ["integrations.status", "integrations.manage"])).toMatchObject({ ok: false, problem: { code: "role_cannot_manage" } });
    expect(checkGrants("analyst", ["staff.team", "staff.timesheets", "staff.manage"])).toMatchObject({ ok: false, problem: { code: "role_cannot_manage" } });
    expect(checkGrants("manager", ["integrations.status", "integrations.manage"]).ok).toBe(true);
    expect(checkGrants("admin", ["analytics.sales"])).toMatchObject({ ok: false, problem: { code: "not_restricted" } });
    expect(checkGrants("admin", [])).toEqual({ ok: true, keys: [] });
  });

  it("the editor ticks what a permission sits inside, and unticks what sits inside it", () => {
    expect([...addPermission([], "customers.contact")].sort()).toEqual(["customers.contact", "customers.list"]);
    expect([...addPermission(["analytics.sales"], "finance.refunds")].sort()).toEqual(["analytics.sales", "finance.refunds"]);
    expect([...addPermission([], "staff.manage")].sort()).toEqual(["staff.manage", "staff.team", "staff.timesheets"]);
    expect([...removePermission(["customers.list", "customers.contact", "customers.orders", "products.view"], "customers.list")]).toEqual(["products.view"]);
    expect([...removePermission(["staff.team", "staff.timesheets", "staff.manage"], "staff.timesheets")]).toEqual(["staff.team"]);
    // Whatever the editor makes, checkGrants accepts.
    expect(checkGrants("custom", [...addPermission(addPermission([], "marketing.attribution"), "products.prices")]).ok).toBe(true);
  });

  it("returns the keys sorted in catalog order, without duplicates, and adds nothing", () => {
    expect(checkGrants("custom", ["products.view", "analytics.sales", "products.view"])).toEqual({ ok: true, keys: ["analytics.sales", "products.view"] });
  });
});

describe("allows", () => {
  it("owners and admins hold every catalog permission; workspace permissions follow roles.ts", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(allows(member([], role), "customers.contact")).toBe(true);
      expect(allows(member([], role), "members:manage")).toBe(true);
    }
    expect(allows(member([], "admin"), "billing:manage")).toBe(false);
    expect(grantedKeys(member([], "owner")).size).toBe(ACCESS_KEYS.length);
  });

  it("restricted members hold only what they were granted, and never run the workspace", () => {
    const m = member(["customers.list", "customers.contact", "integrations.status", "integrations.manage"], "manager");
    expect(allows(m, "customers.list")).toBe(true);
    expect(allows(m, "products.view")).toBe(false);
    expect(allows(m, ["products.view", "customers.list"])).toBe(true);
    expect(allows(m, "dashboard:read")).toBe(true);
    expect(allows(m, "customers:contact")).toBe(true);
    expect(allows(m, "email:manage")).toBe(true);
    for (const p of ["stores:manage", "members:manage", "apikeys:manage", "billing:manage", "audit:read", "workspace:delete", "email:automate"] as const) expect(allows(m, p), p).toBe(false);
    // Unknown strings in a stored list grant nothing.
    expect(grantedKeys(member(["admin", "*"])).size).toBe(0);
  });

  it("a restricted role on its own (can) holds nothing: a check that forgets the grants fails closed", () => {
    for (const role of RESTRICTED_ROLES) expect(can(role, "dashboard:read")).toBe(false);
  });

  it("names the modules a member has anything in", () => {
    expect(modulesOf(member(["customers.list", "products.view", "marketing.ads"]))).toEqual(["customers", "products", "marketing"]);
    expect(modulesOf(member([]))).toEqual([]);
  });
});

const report = () => ({
  store: { id: "s" },
  capabilities: [{ id: "sales_overview" }, { id: "top_products" }, { id: "contacts" }, { id: "inventory" }, { id: "funnel" }],
  data: {
    orders: 10,
    products: 4,
    variants: 6,
    oldestOrderDay: "2026-01-01",
    newestOrderDay: "2026-10-01",
    historyFrom: "2025-12-28",
    createdDay: "2025-12-01",
    startDay: "2025-12-01",
    history: { access: "granted", years: [{ year: 2026, status: "done", orders: 10, finishedAt: null }] },
  },
  modules: {
    sales_overview: {
      current: { grossSales: 120, discounts: 10, returns: 10, netSales: 100, totalSales: 115, totalRefunded: 12, orders: 3, units: 4, averageOrderValue: 33, tax: 5, shipping: 7, duties: 2, additionalFees: 1 },
      previous: { grossSales: 90, netSales: 80, totalSales: 90, tax: 4, shipping: 6, duties: 0, additionalFees: 0, orders: 2, units: 2, averageOrderValue: 40 },
      deltas: { netSales: 0.25, totalSales: 0.24, orders: 0.5, averageOrderValue: -0.1, grossSales: 0.3, units: 1 },
      series: [{ day: "2026-10-01", netSales: 100, totalSales: 115, shipping: 7, tax: 5, duties: 2, additionalFees: 1, orders: 3, refunds: 10, averageOrderValue: 33, newCustomerOrders: 2 }],
      year: {
        year: 2026,
        months: [
          {
            month: "2026-10",
            from: "2026-10-01",
            to: "2026-10-01",
            current: true,
            coverage: "full",
            netSales: 100,
            orders: 3,
            refunds: 10,
            averageOrderValue: 33,
            additionalFees: 1,
            duties: 2,
            shipping: 7,
            taxes: 5,
            totalSales: 115,
            change: 0.25,
            comparedWith: { from: "2026-09-01", to: "2026-09-01" },
            comparedLines: { netSales: 80, additionalFees: 0, duties: 0, shipping: 6, taxes: 4, totalSales: 90 },
          },
        ],
        total: 100,
        orders: 3,
      },
      calculation: { components: { netSales: true, additionalFees: true, duties: false, shipping: true, taxes: false }, label: null, applyToDashboard: true, presets: [], updatedAt: "2026-10-19T00:00:00.000Z" },
    },
    top_products: { items: [{ title: "Hat", revenue: 100, units: 4 }] },
    inventory: { current: { trackedVariants: 1, unitsInStock: 2, stockValueAtCost: 80, variantsWithCost: 1, retailValue: 200, outOfStock: 0, lowStock: 1 }, lowStockItems: [] },
    recent_orders: { items: [{ id: "o", name: "#1", total: 100, financialStatus: "paid", fulfillmentStatus: null, cancelled: false, units: 1, channel: "web" }], cancelledInRange: 2 },
    order_outcomes: {
      orders: 5,
      outcome: { completed: 3, awaitingPayment: 1, unsuccessful: 1, cancelled: 1, paymentFailed: 0, refunded: 0 },
      shipping: { orders: 4, sent: 2, partlySent: 0, notSent: 2, items: 9, itemsSent: 4 },
      checkouts: { started: 6, completed: 3, left: 3, from: null },
    },
    traffic: { items: [{ id: "t", source: "google", label: "Google", orders: 1, sales: 10, paidOrders: 1, paidSales: 10, share: 1 }], paid: { orders: 1, sales: 10, share: 1 }, campaigns: [{ campaign: "x" }], pending: 0 },
    channels: { items: [] },
    discount_codes: { items: [{ code: "SAVE", orders: 2, discount: 5, sales: 50 }] },
    ads: { currency: "USD", campaigns: [{ name: "c" }], current: { spend: 1 }, sales: { netSales: 10, orders: 1 }, sourced: [{ provider: "meta", orders: 1, sales: 10, salesPerSpend: 10 }] },
    ad_connections: { meta: 1, google: 0, adsense: 0, hidden: 0 },
    mystery_new_module: { secret: 1 },
  },
});

describe("redactOverview", () => {
  it("gives owners and admins the report unchanged", () => {
    const r = report();
    expect(redactOverview(r, member([], "owner"))).toBe(r);
  });

  it("keeps only granted modules and capabilities; a module it doesn't know stays closed", () => {
    const out = redactOverview(report(), member(["products.performance"]));
    expect(Object.keys(out.modules)).toEqual(["top_products"]);
    expect(out.capabilities.map((c) => c.id)).toEqual(["top_products"]);
    // The orders' history (how many each imported year holds) goes with the orders; where the dates begin stays.
    expect(out.data).toEqual({ products: 4, variants: 6, createdDay: "2025-12-01", startDay: "2025-12-01" });
    expect(seesModule(member(["products.performance"]), "mystery_new_module")).toBe(false);
    expect(seesModule(member([], "admin"), "mystery_new_module")).toBe(true);
  });

  it("takes out the fields that need their own permission", () => {
    const out = redactOverview(report(), member(["analytics.sales", "products.inventory", "orders.list", "analytics.traffic", "discounts.codes", "marketing.ads"])) as ReturnType<typeof report>;
    const s = out.modules.sales_overview as unknown as Record<string, Record<string, unknown>> & { series: Array<Record<string, unknown>> };
    // Total sales holds tax and shipping, and returns are refunds: both go with them.
    expect(s.current).toEqual({ netSales: 100, orders: 3, units: 4, averageOrderValue: 33 });
    expect(s.previous).toEqual({ netSales: 80, orders: 2, units: 2, averageOrderValue: 40 });
    expect(s.deltas).not.toHaveProperty("grossSales");
    expect(s.deltas).not.toHaveProperty("totalSales");
    expect(s).not.toHaveProperty("year");
    // The store's own calculation is drawn from those lines, so it goes with them.
    expect(s).not.toHaveProperty("calculation");
    // Which orders were a customer's first is customer analytics.
    expect(s.series[0]).toEqual({ day: "2026-10-01", netSales: 100, orders: 3, averageOrderValue: 33 });
    expect(out.modules.inventory.current).not.toHaveProperty("stockValueAtCost");
    expect(out.modules.inventory.current).not.toHaveProperty("retailValue");
    expect(out.modules.recent_orders.items[0]).toEqual({ id: "o", name: "#1", total: 100, units: 1, channel: "web" });
    // How many orders were cancelled in the dates is cancellation detail too.
    expect(out.modules.recent_orders).not.toHaveProperty("cancelledInRange");
    expect(out.modules.traffic).not.toHaveProperty("campaigns");
    expect(out.modules.traffic).not.toHaveProperty("paid");
    expect(out.modules.traffic.items[0]).not.toHaveProperty("paidSales");
    expect(out.modules.discount_codes.items[0]).toEqual({ code: "SAVE", orders: 2 });
    expect(out.modules.ads).not.toHaveProperty("campaigns");
    // Orders Shopify credits to a platform's ads are attribution, like the traffic module's paid figures; the store's own sales next to the spend stay.
    expect(out.modules.ads).not.toHaveProperty("sourced");
    expect(out.modules.ads).toHaveProperty("sales");
    expect(out.modules).toHaveProperty("ad_connections");
    // Sales figures come with the dates they were imported from (a member without them gets neither, above).
    expect(out.data).toMatchObject({ orders: 10, oldestOrderDay: "2026-01-01", historyFrom: "2025-12-28", history: { access: "granted" } });
    // The original is untouched.
    expect(report().modules.sales_overview.current.grossSales).toBe(120);
  });

  it("keeps this year month by month for financial reports, its lines of total sales only with the breakdown", () => {
    const reports = redactOverview(report(), member(["analytics.sales", "finance.reports"])) as ReturnType<typeof report>;
    const y = reports.modules.sales_overview.year;
    expect(y).toMatchObject({ year: 2026, total: 100, orders: 3 });
    expect(y.months[0]).toMatchObject({ month: "2026-10", coverage: "full", netSales: 100, orders: 3, change: 0.25, comparedWith: { from: "2026-09-01", to: "2026-09-01" } });
    // Custom sales is drawn from the lines, so neither the month's lines nor those it is compared on stay.
    for (const k of MONTH_LINES) expect(y.months[0]).not.toHaveProperty(k);
    expect(reports.modules.sales_overview).not.toHaveProperty("calculation");

    const both = redactOverview(report(), member(["analytics.sales", "finance.reports", "finance.breakdown", "finance.refunds"])) as ReturnType<typeof report>;
    expect(both.modules.sales_overview.year.months[0]).toEqual(report().modules.sales_overview.year.months[0]);
    // The original is untouched.
    expect(report().modules.sales_overview.year.months[0]!.taxes).toBe(5);
  });

  it("redacts the years this year is compared with as it does this year's months", () => {
    const withPast = () => {
      const r = report();
      const y = r.modules.sales_overview.year;
      const past = { ...y, year: 2025, months: y.months.map((m) => ({ ...m, month: "2025-10", current: false })) };
      return { ...r, modules: { ...r.modules, sales_overview: { ...r.modules.sales_overview, year: { ...y, past: [past] } } } };
    };
    type WithPast = ReturnType<typeof withPast>;
    const reports = redactOverview(withPast(), member(["analytics.sales", "finance.reports"])) as WithPast;
    const past = reports.modules.sales_overview.year.past[0]!;
    expect(past).toMatchObject({ year: 2025, total: 100 });
    expect(past.months[0]).toMatchObject({ month: "2025-10", netSales: 100, orders: 3 });
    for (const k of [...MONTH_LINES, "refunds"]) expect(past.months[0]).not.toHaveProperty(k);

    const all = redactOverview(withPast(), member(["analytics.sales", "finance.reports", "finance.breakdown", "finance.refunds"])) as WithPast;
    expect(all.modules.sales_overview.year.past[0]!.months[0]).toEqual(withPast().modules.sales_overview.year.past[0]!.months[0]);
    expect(redactOverview(withPast(), member(["analytics.sales"])).modules.sales_overview).not.toHaveProperty("year");
  });

  it("keeps what refunds took off total sales only with both View refunds and the breakdown", () => {
    // It holds the refunds' tax and shipping, so it needs the lines as well as the refunds.
    const current = (keys: string[]) => (redactOverview(report(), member(["analytics.sales", ...keys])) as ReturnType<typeof report>).modules.sales_overview.current;
    expect(current(["finance.refunds"])).not.toHaveProperty("totalRefunded");
    expect(current(["finance.breakdown"])).not.toHaveProperty("totalRefunded");
    expect(current(["finance.breakdown", "finance.refunds"])).toMatchObject({ totalSales: 115, totalRefunded: 12 });
  });

  it("keeps each month's refunds only with View refunds", () => {
    const reports = redactOverview(report(), member(["analytics.sales", "finance.reports"])) as ReturnType<typeof report>;
    for (const m of reports.modules.sales_overview.year.months) expect(m).not.toHaveProperty("refunds");
    expect(reports.modules.sales_overview.year.months[0]).toMatchObject({ netSales: 100, orders: 3 });

    const refunds = redactOverview(report(), member(["analytics.sales", "finance.reports", "finance.refunds"])) as ReturnType<typeof report>;
    expect(refunds.modules.sales_overview.year.months[0]).toMatchObject({ refunds: 10, netSales: 100 });
    // The breakdown's lines still need their own permission.
    for (const k of MONTH_LINES) expect(refunds.modules.sales_overview.year.months[0]).not.toHaveProperty(k);

    // With the breakdown but without refunds: the lines stay, the refunds go.
    const lines = redactOverview(report(), member(["analytics.sales", "finance.reports", "finance.breakdown"])) as ReturnType<typeof report>;
    const { refunds: _refunds, ...withoutRefunds } = report().modules.sales_overview.year.months[0]!;
    expect(lines.modules.sales_overview.year.months[0]).toEqual(withoutRefunds);
    // The original is untouched.
    expect(report().modules.sales_overview.year.months[0]!.refunds).toBe(10);
  });

  it("shows how the dates' orders went part by part: payments with cancellations, shipping, checkouts left", () => {
    const parts = (keys: string[]) => Object.keys(redactOverview(report(), member(keys)).modules.order_outcomes ?? {}).sort();
    expect(parts(["orders.list"])).toEqual(["orders"]);
    // Unsuccessful orders are mostly cancelled ones: payment status alone doesn't show them.
    expect(parts(["orders.list", "orders.payments"])).toEqual(["orders"]);
    expect(parts(["orders.list", "orders.payments", "orders.cancellations"])).toEqual(["orders", "outcome"]);
    expect(parts(["orders.fulfillment"])).toEqual(["orders", "shipping"]);
    // Checkouts left alone don't tell how many orders the store took.
    expect(parts(["analytics.abandonment"])).toEqual(["checkouts"]);
    expect(parts(["products.performance"])).toEqual([]);
    expect(redactOverview(report(), member([...LEGACY_GRANTS.viewer, "orders.payments", "orders.cancellations", "orders.fulfillment", "analytics.abandonment"])).modules.order_outcomes).toEqual(report().modules.order_outcomes);
  });

  it("gives Shopify's gross profit only with both the breakdown and the costs permission", () => {
    const withProfit = () => ({ ...report(), capabilities: [...report().capabilities, { id: "profit" }], modules: { ...report().modules, profit: { status: "ready", current: { grossProfit: 900, costOfGoodsSold: 650 } }, shopify_check: { rows: [] } } });
    const sees = (keys: string[]) => {
      const out = redactOverview(withProfit(), member(keys));
      return { profit: "profit" in out.modules, capability: out.capabilities.some((c) => c.id === "profit"), check: "shopify_check" in out.modules };
    };
    // Legacy viewers and analysts, and API keys, hold the breakdown but not the costs.
    expect(sees([...LEGACY_GRANTS.viewer])).toEqual({ profit: false, capability: false, check: true });
    expect(sees([...LEGACY_GRANTS.analyst])).toEqual({ profit: false, capability: false, check: true });
    expect(sees(["inventory.view", "inventory.costs"])).toEqual({ profit: false, capability: false, check: false });
    expect(sees(["analytics.sales", "finance.breakdown", "inventory.view", "inventory.costs"])).toEqual({ profit: true, capability: true, check: true });
    expect(seesModule(member([], "owner"), "profit")).toBe(true);
  });

  it("lists Shopify's abandoned checkouts among the capabilities of a member who may see checkout abandonment", () => {
    const withCheckouts = { ...report(), capabilities: [...report().capabilities, { id: "abandoned_checkouts" }] };
    expect(redactOverview(withCheckouts, member(["analytics.abandonment"])).capabilities.map((c) => c.id)).toEqual(["contacts", "abandoned_checkouts"]);
    expect(redactOverview(withCheckouts, member(["analytics.sales"])).capabilities.map((c) => c.id)).toEqual(["sales_overview"]);
  });

  it("keeps them once granted", () => {
    const out = redactOverview(report(), member([...LEGACY_GRANTS.viewer, "reports.export"])) as ReturnType<typeof report>;
    expect(out.modules.sales_overview.current.grossSales).toBe(120);
    expect(out.modules.sales_overview.current).toMatchObject({ totalSales: 115, totalRefunded: 12, returns: 10, duties: 2, additionalFees: 1 });
    expect(out.modules.sales_overview.previous).toMatchObject({ tax: 4, shipping: 6 });
    expect(out.modules.sales_overview.series[0]).toMatchObject({ refunds: 10, totalSales: 115, tax: 5, duties: 2, newCustomerOrders: 2 });
    expect(out.modules.sales_overview.calculation.applyToDashboard).toBe(true);
    expect(out.modules.sales_overview.year.months[0]).toMatchObject({ taxes: 5, totalSales: 115, comparedLines: { shipping: 6 } });
    expect(out.modules.inventory.current.retailValue).toBe(200);
    expect(out.modules.recent_orders.items[0]!.financialStatus).toBe("paid");
    expect(out.modules.recent_orders.cancelledInRange).toBe(2);
  });
});

describe("redactContact", () => {
  const row = { customerId: "1", name: "Jane", email: "j@x.com", phone: "+61", subscribed: true, smsSubscribed: false, adminUrl: "https://a", orders: 2, spent: 10, recoveryUrl: "https://r" };
  it("shows a customer number only, until names, contact details and order history are granted", () => {
    expect(redactContact(row, member(["customers.list"]))).toEqual({ ...row, name: null, adminUrl: null, email: null, phone: null, recoveryUrl: null, orders: null, spent: null });
    expect(redactContact(row, member(["customers.list", "customers.profiles"]))).toMatchObject({ name: "Jane", email: null });
    expect(redactContact(row, member(["customers.list", "customers.contact", "customers.orders"]))).toMatchObject({ name: null, email: "j@x.com", recoveryUrl: "https://r", orders: 2 });
    expect(redactContact(row, member([], "owner"))).toBe(row);
  });
});

describe("staff access from Team & Access permissions", () => {
  it("maps staff permissions to Staff Management rights for every employee; exports need the export permission", () => {
    expect(staffAccess("custom", null, ["staff.team"])).toEqual({ permissions: ["staff:view"], scope: "all", staffRole: null });
    expect(staffAccess("manager", null, ["staff.team", "staff.timesheets", "staff.manage", "reports.export"]).permissions).toEqual([
      "staff:view",
      "staff:manage",
      "attendance:view",
      "attendance:manage",
      "staff:export",
    ]);
    expect(staffAccess("custom", null, ["staff.team", "staff.payroll"]).permissions).toEqual(["staff:view", "pay:view"]);
    expect(staffAccess("custom", null, ["reports.export"]).permissions).toEqual([]);
    expect(staffAccess("viewer", "supervisor", []).scope).toBe("assigned");
    expect(staffAccess("owner", null, []).permissions.length).toBeGreaterThan(5);
  });
});

describe("a session opened from a shared link", () => {
  it("keeps what the member may look at and download, never what changes anything", () => {
    const manager = linkSessionAccess({ role: "manager", permissions: ["integrations.status", "integrations.manage", "staff.team", "staff.timesheets", "staff.manage", "reports.export"] });
    expect(manager.permissions).toEqual(["integrations.status", "staff.team", "staff.timesheets", "reports.export"]);
    expect(allows(manager, "integrations.manage")).toBe(false);
    expect(allows(manager, "email:manage")).toBe(false);
    expect(allows(manager, "reports.export")).toBe(true);
  });

  it("makes an owner's or admin's link a viewer of everything, with no management at all", () => {
    for (const role of ["owner", "admin"] as const) {
      const a = linkSessionAccess({ role, permissions: [] });
      expect(a.role).toBe("viewer");
      expect(a.permissions).toContain("customers.contact");
      expect(a.permissions).not.toContain("integrations.manage");
      expect(a.permissions).not.toContain("staff.manage");
      for (const need of ["members:manage", "stores:manage", "billing:manage", "apikeys:manage", "audit:read", "workspace:delete", "email:manage", "email:automate"] as const) {
        expect(allows(a, need), `${role} ${need}`).toBe(false);
      }
    }
  });
});
