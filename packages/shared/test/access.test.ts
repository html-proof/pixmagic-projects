import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCESS_KEYS,
  ACCESS_PERMISSIONS,
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
import { can } from "../src/roles";
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
  data: { orders: 10, products: 4, variants: 6, oldestOrderDay: "2026-01-01", newestOrderDay: "2026-10-01", historyFrom: "2025-12-28" },
  modules: {
    sales_overview: {
      current: { grossSales: 120, discounts: 10, returns: 10, netSales: 100, totalSales: 115, orders: 3, units: 4, averageOrderValue: 33, tax: 5, shipping: 7, duties: 2, additionalFees: 1 },
      previous: { grossSales: 90, netSales: 80, totalSales: 90, tax: 4, shipping: 6, duties: 0, additionalFees: 0, orders: 2, units: 2, averageOrderValue: 40 },
      deltas: { netSales: 0.25, totalSales: 0.24, orders: 0.5, averageOrderValue: -0.1, grossSales: 0.3, units: 1 },
      series: [{ day: "2026-10-01", netSales: 100, totalSales: 115, shipping: 7, tax: 5, duties: 2, additionalFees: 1, orders: 3, refunds: 10, averageOrderValue: 33 }],
      year: { year: 2026, months: [], total: 100, orders: 3 },
      calculation: { components: { netSales: true, additionalFees: true, duties: false, shipping: true, taxes: false }, label: null, applyToDashboard: true, presets: [], updatedAt: "2026-10-19T00:00:00.000Z" },
    },
    top_products: { items: [{ title: "Hat", revenue: 100, units: 4 }] },
    inventory: { current: { trackedVariants: 1, unitsInStock: 2, stockValueAtCost: 80, variantsWithCost: 1, retailValue: 200, outOfStock: 0, lowStock: 1 }, lowStockItems: [] },
    recent_orders: { items: [{ id: "o", name: "#1", total: 100, financialStatus: "paid", fulfillmentStatus: null, cancelled: false, units: 1, channel: "web" }] },
    traffic: { items: [{ id: "t", source: "google", label: "Google", orders: 1, sales: 10, paidOrders: 1, paidSales: 10, share: 1 }], paid: { orders: 1, sales: 10, share: 1 }, campaigns: [{ campaign: "x" }], pending: 0 },
    channels: { items: [] },
    discount_codes: { items: [{ code: "SAVE", orders: 2, discount: 5, sales: 50 }] },
    ads: { currency: "USD", campaigns: [{ name: "c" }], current: { spend: 1 } },
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
    expect(out.data).toEqual({ products: 4, variants: 6 });
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
    expect(s.series[0]).toEqual({ day: "2026-10-01", netSales: 100, orders: 3, averageOrderValue: 33 });
    expect(out.modules.inventory.current).not.toHaveProperty("stockValueAtCost");
    expect(out.modules.inventory.current).not.toHaveProperty("retailValue");
    expect(out.modules.recent_orders.items[0]).toEqual({ id: "o", name: "#1", total: 100, units: 1, channel: "web" });
    expect(out.modules.traffic).not.toHaveProperty("campaigns");
    expect(out.modules.traffic).not.toHaveProperty("paid");
    expect(out.modules.traffic.items[0]).not.toHaveProperty("paidSales");
    expect(out.modules.discount_codes.items[0]).toEqual({ code: "SAVE", orders: 2 });
    expect(out.modules.ads).not.toHaveProperty("campaigns");
    expect(out.modules).toHaveProperty("ad_connections");
    // Sales figures come with the dates they were imported from (a member without them gets neither, above).
    expect(out.data).toMatchObject({ orders: 10, oldestOrderDay: "2026-01-01", historyFrom: "2025-12-28" });
    // The original is untouched.
    expect(report().modules.sales_overview.current.grossSales).toBe(120);
  });

  it("keeps them once granted", () => {
    const out = redactOverview(report(), member([...LEGACY_GRANTS.viewer, "reports.export"])) as ReturnType<typeof report>;
    expect(out.modules.sales_overview.current.grossSales).toBe(120);
    expect(out.modules.sales_overview.current).toMatchObject({ totalSales: 115, returns: 10, duties: 2, additionalFees: 1 });
    expect(out.modules.sales_overview.previous).toMatchObject({ tax: 4, shipping: 6 });
    expect(out.modules.sales_overview.series[0]).toMatchObject({ refunds: 10, totalSales: 115, tax: 5, duties: 2 });
    expect(out.modules.sales_overview.calculation.applyToDashboard).toBe(true);
    expect(out.modules.inventory.current.retailValue).toBe(200);
    expect(out.modules.recent_orders.items[0]!.financialStatus).toBe("paid");
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
