import { expect, test, type Locator } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, stubShopify, uniqueEmail } from "./helpers";

/**
 * The Shopify analytics screens, from rows written straight into the database (Shopify can't run in
 * e2e): Sales by collection on the products page and the Top products filter it sets, Repeat
 * customers and Monthly cohorts on the Customers page, and Shopify's own abandoned checkouts on the
 * Shopping Funnel page. Every store keeps UTC, so its days are the UTC days worked out here.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

const DAY_MS = 86_400_000;
/** The UTC day `n` days from today ("YYYY-MM-DD"). */
const utcDay = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
/** The UTC calendar month `back` months before this one ("YYYY-MM"). */
function utcMonth(back: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
}
/** The last day of a month ("YYYY-MM" → "YYYY-MM-DD"). */
const lastDayOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** A figure on a card (Primitives' Stat): its label, then its value, then a line of context. */
const stat = (scope: Locator, label: string) => scope.getByText(label, { exact: true }).first().locator("..");
const statValue = (scope: Locator, label: string) => stat(scope, label).locator("p").nth(1);

/**
 * A store whose whole order history is imported and that was just synced, with a sync running so
 * background refresh leaves this offline fixture alone (as topProducts.spec.ts does).
 */
async function quietStore(ws: string, store: string) {
  await db.query("UPDATE stores SET orders_history_from = '1970-01-01', last_synced_at = now() WHERE id = $1", [store]);
  await db.query(
    "INSERT INTO sync_jobs (id, workspace_id, store_id, kind, status, created_at, started_at, last_activity_at) VALUES (gen_random_uuid()::text, $1, $2, 'shop', 'running', now(), now(), now())",
    [ws, store],
  );
}

interface Line {
  product: string;
  title: string;
  quantity: number;
  /** Net sales of the line (no tax, no discount). */
  amount: number;
}

/**
 * An order at noon (UTC) on `day` as the pipeline stores it: its line items and their sales
 * records, read from Shopify (sales_updated_at set). `customer`: its keyed customer (null: a guest)
 * and whether Shopify counts it as a returning customer's.
 */
async function seedOrder(ws: string, store: string, id: string, day: string, lines: Line[], customer: { key: string | null; returning: boolean } = { key: null, returning: false }) {
  const at = `${day}T12:00:00`;
  const total = lines.reduce((a, l) => a + l.amount, 0);
  const { rows } = await db.query(
    `INSERT INTO orders (id, workspace_id, store_id, shopify_id, name, currency, local_day, shopify_created_at, shopify_updated_at, shopify_processed_at, sales_updated_at,
       traffic_source, subtotal, total_discounts, total_tax, total_shipping, total_price, customer_key, is_returning_customer)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'USD', $5, $6::timestamp, $6::timestamp, $6::timestamp, $6::timestamp, 'direct', $7, 0, 0, 0, $7, $8, $9)
     RETURNING id`,
    [ws, store, id, `#${id}`, day, at, total, customer.key, customer.returning],
  );
  const orderId = rows[0].id as string;
  for (const [i, l] of lines.entries()) {
    const line = `${id}-line-${i}`;
    await db.query(
      `INSERT INTO order_line_items (id, workspace_id, store_id, order_id, shopify_id, product_shopify_id, variant_shopify_id, sku, title, quantity, price, discount)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)`,
      [ws, store, orderId, line, l.product, `${l.product}-v`, `SKU-${l.product}`, l.title, l.quantity, l.amount / l.quantity],
    );
    await db.query(
      `INSERT INTO order_sales (id, workspace_id, store_id, order_id, shopify_id, local_day, happened_at, action_type, line_type, line_item_shopify_id, quantity, amount, discount, tax)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::timestamp, 'order', 'product', $7, $8, $9, 0, 0)`,
      [ws, store, orderId, `${id}-sale-${i}`, day, at, line, l.quantity, l.amount],
    );
  }
}

test("sales by collection lists each collection's sales, pins the rest, and narrows Top products to one", async ({ page }) => {
  await signUp(page, uniqueEmail("collections"));
  const ws = await createWorkspace(page, "Collections Co");
  const store = await insertStore(db, ws, `collections-${Date.now()}.myshopify.com`);
  await quietStore(ws, store);
  // Yesterday: a finished day, whatever the time (as topProducts.spec.ts); nothing sold the day before.
  const day = utcDay(-1);
  // The tee is in two collections, the hat in one of them, the mug in another; the gift note in
  // none, and the mystery box's collections were never read (NULL).
  const products: Array<[string, string, unknown]> = [
    ["101", "Linen Tee", [{ id: "10", title: "Summer" }, { id: "11", title: "Sale" }]],
    ["102", "Stone Mug", [{ id: "12", title: "Home" }]],
    ["103", "Gift Note", []],
    ["104", "Mystery Box", null],
    ["105", "Straw Hat", [{ id: "11", title: "Sale" }]],
  ];
  for (const [id, title, collections] of products) {
    await db.query(
      `INSERT INTO products (id, workspace_id, store_id, shopify_id, title, collections, shopify_updated_at) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5::jsonb, now())`,
      [ws, store, id, title, collections === null ? null : JSON.stringify(collections)],
    );
  }
  const tee = (quantity: number) => ({ product: "101", title: "Linen Tee", quantity, amount: 30 * quantity });
  await seedOrder(ws, store, "col-a", day, [tee(2), { product: "102", title: "Stone Mug", quantity: 1, amount: 25 }]);
  await seedOrder(ws, store, "col-b", day, [tee(1), { product: "103", title: "Gift Note", quantity: 1, amount: 5 }]);
  await seedOrder(ws, store, "col-c", day, [{ product: "104", title: "Mystery Box", quantity: 1, amount: 40 }, { product: "105", title: "Straw Hat", quantity: 1, amount: 20 }]);

  await page.goto(`/dashboard?preset=custom&from=${day}&to=${day}&view=products`);
  const collections = page.getByTestId("module-d-collection-sales");
  await expect(collections.getByRole("heading", { name: "Sales by collection" })).toBeVisible({ timeout: 20_000 });
  await expect(collections.getByRole("columnheader")).toHaveText(["Collection", "Net sales", "Net units", "Orders", "Products sold", "Share of product sales"], { timeout: 15_000 });
  // Best-selling first, then the two pinned rows.
  await expect(collections.locator("tbody tr th")).toHaveText(["Sale", "Summer", "Home", /^Not in a collection/, /^Collections not known/]);
  const row = (title: string) => collections.locator("tbody tr").filter({ has: page.getByRole("button", { name: `Show ${title} in Top products`, exact: true }) });
  // Of $180 of product sales: Sale = 3 tees ($90) + the hat ($20) in all three orders; Summer = the tees only.
  await expect(row("Sale").getByRole("cell")).toHaveText(["$110.00", "4", "3", "2", "61.1%"]);
  await expect(row("Summer").getByRole("cell")).toHaveText(["$90.00", "3", "2", "1", "50%"]);
  await expect(row("Home").getByRole("cell")).toHaveText(["$25.00", "1", "1", "1", "13.9%"]);
  const pinned = (label: string) => collections.locator("tbody tr").filter({ hasText: label });
  await expect(pinned("Not in a collection")).toContainText("Products in none of your collections.");
  await expect(pinned("Not in a collection").getByRole("cell")).toHaveText(["$5.00", "1", "1", "1", "2.8%"]);
  await expect(pinned("Collections not known")).toContainText("Products added since your catalog was last read, or no longer in it.");
  await expect(pinned("Collections not known").getByRole("cell")).toHaveText(["$40.00", "1", "1", "1", "22.2%"]);
  // Each sale once: the tee is counted in two collections above, here once.
  await expect(collections).toContainText("All product sales, each once: $180.00 · 7 units · 3 orders.");
  await expect(collections).toContainText("Your catalog's collections haven't been read from Shopify yet.");
  const download = page.waitForEvent("download");
  await collections.getByRole("button", { name: "Export CSV" }).click();
  expect((await download).suggestedFilename()).toBe(`collection-sales-${day}-${day}.csv`);

  // A collection's name narrows Top products to its products.
  const top = page.locator("#d-top-products");
  await expect(top.locator("tbody tr")).toHaveCount(5, { timeout: 15_000 });
  await row("Sale").getByRole("button", { name: "Show Sale in Top products", exact: true }).click();
  const clearSale = top.getByRole("button", { name: "Show all products, not only Sale", exact: true });
  await expect(clearSale).toBeVisible();
  await expect(top).toContainText("Collection: Sale");
  await expect(top.getByLabel("Collection", { exact: true })).toHaveValue("11");
  await expect(top.locator("tbody tr")).toHaveCount(2, { timeout: 15_000 });
  await expect(top.locator("tbody tr").nth(0)).toContainText("Linen Tee");
  await expect(top.locator("tbody tr").nth(1)).toContainText("Straw Hat");
  // The chip's button shows every product again.
  await clearSale.click();
  await expect(clearSale).toHaveCount(0);
  await expect(top.getByLabel("Collection", { exact: true })).toHaveValue("");
  await expect(top.locator("tbody tr")).toHaveCount(5, { timeout: 15_000 });
  // Top products' own list picks a collection too.
  await top.getByLabel("Collection", { exact: true }).selectOption({ label: "Home" });
  await expect(top.getByRole("button", { name: "Show all products, not only Home", exact: true })).toBeVisible();
  await expect(top.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
  await expect(top.locator("tbody tr").first()).toContainText("Stone Mug");
});

test("repeat customers and monthly cohorts count the stored orders' customers", async ({ page }) => {
  await signUp(page, uniqueEmail("cohorts"));
  const ws = await createWorkspace(page, "Cohorts Co");
  const store = await insertStore(db, ws, `cohorts-${Date.now()}.myshopify.com`, ["read_orders", "read_products", "read_customers"]);
  await quietStore(ws, store);
  // Two and one calendar months back (finished months), and this one (running).
  const [m2, m1, m0] = [utcMonth(2), utcMonth(1), utcMonth(0)];
  const bag = (amount: number) => [{ product: "201", title: "Canvas Bag", quantity: 1, amount }];
  // A first bought on the 1st two months back and came back last month; B bought once; a guest once.
  await seedOrder(ws, store, "a1", `${m2}-01`, bag(50), { key: "e2e-customer-a", returning: false });
  await seedOrder(ws, store, "b1", `${m2}-12`, bag(40), { key: "e2e-customer-b", returning: false });
  await seedOrder(ws, store, "guest", `${m2}-15`, bag(99));
  await seedOrder(ws, store, "a2", `${m1}-10`, bag(30), { key: "e2e-customer-a", returning: true });
  // The day totals recomputeDays keeps: where customers are known from comes from them.
  const days: Array<[string, number, number, number]> = [
    [`${m2}-01`, 50, 1, 0],
    [`${m2}-12`, 40, 1, 0],
    [`${m2}-15`, 99, 0, 0],
    [`${m1}-10`, 30, 1, 1],
  ];
  for (const [day, sales, withCustomer, returning] of days) {
    await db.query(
      `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, total_sales, order_value, orders, units, orders_with_customer, returning_customer_orders)
       VALUES ($1, $2, $3, $4, $4, $4, 1, 1, $5, $6)`,
      [ws, store, day, sales, withCustomer, returning],
    );
  }

  // The two finished months: every order seeded is in these dates.
  await page.goto(`/dashboard?preset=custom&from=${m2}-01&to=${lastDayOf(m1)}&view=customers`);
  const repeat = page.getByTestId("module-d-customer-value");
  await expect(repeat.getByRole("heading", { name: "Repeat customers" })).toBeVisible({ timeout: 20_000 });
  const dates = repeat.getByTestId("customers-dates");
  // A and B ordered (the guest is no customer); only A twice: 3 orders, $120 of net sales.
  await expect(statValue(dates, "Repeat purchase rate")).toHaveText("50%", { timeout: 15_000 });
  await expect(stat(dates, "Repeat purchase rate")).toContainText("1 of 2 customers");
  await expect(statValue(dates, "Orders per customer")).toHaveText("1.5");
  await expect(statValue(dates, "Net sales per customer")).toHaveText("$60.00");
  await expect(statValue(dates, "Orders without a known customer")).toHaveText("1");
  // Everyone who first bought since customers are known: the same two.
  const acquired = repeat.getByTestId("customers-acquired");
  await expect(acquired).toContainText("Customers who first bought since");
  await expect(statValue(acquired, "Customers")).toHaveText("2");
  await expect(statValue(acquired, "Repeat purchase rate")).toHaveText("50%");
  await expect(statValue(acquired, "Orders per customer")).toHaveText("1.5");
  await expect(repeat.getByTestId("customers-unknown")).toHaveCount(0);

  const cohorts = page.getByTestId("module-d-cohorts");
  await expect(cohorts.getByRole("heading", { name: "Monthly cohorts" })).toBeVisible();
  const table = cohorts.getByTestId("cohort-table");
  await expect(table.getByRole("columnheader")).toHaveText(["First order", "Customers", "Month 0", "Month 1", "Month 2"], { timeout: 15_000 });
  // A and B first bought two months back: nobody again that month, A the month after, nobody so far this month.
  await expect(table.getByTestId(`cohort-${m2}`).getByRole("cell")).toHaveText(["2", "0%", "50%", /^0%\s*so far$/]);
  // No first-time buyer last month or this one: no rate, never 0%; a month not come yet has no cell.
  await expect(table.getByTestId(`cohort-${m1}`).getByRole("cell")).toHaveText(["0", "—", /^—\s*so far$/, ""]);
  await expect(table.getByTestId(`cohort-${m0}`).getByRole("cell")).toHaveText(["0", /^—\s*so far$/, "", ""]);
  await expect(cohorts.getByTestId("customers-coverage")).toContainText("Customers are known on the orders bizinsights holds from");
  // What a customer of the cohort has spent so far: $90 ÷ 2 in its first month, $120 ÷ 2 from the next.
  await cohorts.getByLabel("Cohort figure", { exact: true }).selectOption("value");
  await expect(table.getByTestId(`cohort-${m2}`).getByRole("cell")).toHaveText(["2", "$45.00", "$60.00", /^\$60\.00\s*so far$/]);
});

test("the Shopping Funnel shows Shopify's abandoned checkouts, and says when Shopify shares none", async ({ page }) => {
  await signUp(page, uniqueEmail("abandoned"));
  const ws = await createWorkspace(page, "Checkouts Co");
  await stubShopify(page);
  // No pixel: the page's own funnel is locked, Shopify's checkouts (read_orders) still show.
  const store = await insertStore(db, ws, `abandoned-${Date.now()}.myshopify.com`);
  await quietStore(ws, store);
  const keep = (window: string, values: Record<string, unknown> | null, error: string | null = null) =>
    db.query(
      `INSERT INTO shopify_reports (id, workspace_id, store_id, dataset, time_window, "values", error, fetched_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'abandoned_checkouts', $3, $4::jsonb, $5, now() at time zone 'utc')`,
      [ws, store, window, values === null ? null : JSON.stringify(values), error],
    );
  // Finished days inside Shopify's 60 days, so nothing kept is stale and nothing is asked of
  // Shopify (a range running to today would be re-asked every 5 minutes): a week, with the week before kept too.
  const [from, to, cfrom, cto] = [utcDay(-14), utcDay(-8), utcDay(-21), utcDay(-15)];
  const abandoned = [4, 6, 5, 7, 8, 4, 6];
  const recovered = [1, 2, 1, 2, 2, 1, 1];
  await keep(`${from}|${to}|`, {
    abandoned: 40,
    abandonedExact: true,
    recovered: 10,
    recoveredExact: true,
    value: 2000,
    recoveredValue: 400,
    valueGap: null,
    currency: "USD",
    days: abandoned.map((n, i) => ({ day: utcDay(-14 + i), abandoned: n, recovered: recovered[i], value: n * 50 })),
  });
  await keep(`${cfrom}|${cto}|`, { abandoned: 50, abandonedExact: true, recovered: 20, recoveredExact: true, value: 2500, recoveredValue: 800, valueGap: null, currency: "USD", days: null });

  await page.goto(`/funnel?preset=custom&from=${from}&to=${to}`);
  const card = page.getByTestId("module-abandoned");
  await expect(card.getByRole("heading", { name: "Abandoned checkouts (Shopify)" })).toBeVisible({ timeout: 20_000 });
  // 40 checkouts worth $2,000, 10 of them recovered (25%). The week before had 50: no change on it is shown.
  await expect(statValue(card, "Abandoned checkouts")).toHaveText("40", { timeout: 15_000 });
  await expect(statValue(card, "Abandoned checkout value")).toHaveText("$2,000.00");
  await expect(statValue(card, "Recovered so far")).toHaveText("10");
  await expect(stat(card, "Recovered so far")).toContainText("25% of them");
  await expect(statValue(card, "Recovered value")).toHaveText("$400.00");
  await expect(card).not.toContainText("▼");
  await expect(card.getByTestId("abandoned-value-gap")).toHaveCount(0);

  // Shopify refused (no approval for customer data yet): said in words, never 0.
  const denied = utcDay(-5);
  await keep(`${denied}|${denied}|`, null, "access_denied");
  await keep(`${utcDay(-6)}|${utcDay(-6)}|`, null, "access_denied");
  await page.goto(`/funnel?preset=custom&from=${denied}&to=${denied}`);
  await expect(card).toContainText("Shopify hasn't approved bizinsights to read this store's checkouts yet.", { timeout: 20_000 });
  await expect(card.getByText("Abandoned checkout value", { exact: true })).toHaveCount(0);

  // Older than the 60 days Shopify shares: nothing asked, and the page says from when it can show them.
  await page.goto(`/funnel?preset=custom&from=${utcDay(-80)}&to=${utcDay(-74)}`);
  await expect(card).toContainText("Shopify shares the last 60 days of checkouts", { timeout: 20_000 });
  await expect(card.getByText("Abandoned checkouts", { exact: true })).toHaveCount(0);
});
