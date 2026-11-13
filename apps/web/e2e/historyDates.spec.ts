import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

/**
 * Historical dates in the browser: every calendar year of the store in the dates menu, a year
 * earlier or later with a click, at most 12 months at a time (said, with the latest end date), and
 * the line under the dates saying what they cover, from when the orders are in, and that older days
 * are missing rather than days without sales.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

test("any calendar year of the store, 12 months at a time, with where its orders begin", async ({ page }) => {
  const email = uniqueEmail("history");
  await signUp(page, email);
  const ws = await createWorkspace(page, "History Co");
  const shop = `history-${Date.now()}.myshopify.com`;
  // Shopify created the store in March 2022 and shares its last 60 days of orders (no read_all_orders).
  await db.query(
    `INSERT INTO stores (id, workspace_id, shop_domain, status, timezone, currency, granted_scopes, pixel_ingest_key, shop_created_at, orders_history_from, last_synced_at, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, 'active', 'UTC', 'USD', ARRAY['read_orders'], gen_random_uuid()::text,
             '2022-03-14T03:00:00Z', now() - interval '60 days', now(), now(), now())`,
    [ws, shop],
  );

  await page.goto("/dashboard");
  const line = page.getByTestId("history-line");
  await expect(line).toContainText("Showing");
  await expect(line).toContainText("UTC");
  await expect(page.getByTestId("history-availability")).toContainText("Shopify shares only the last 60 days of orders");
  // Nothing the merchant can turn on until Shopify approves bizinsights for it: no button.
  await expect(page.getByTestId("history-availability")).toContainText("Shopify has to approve bizinsights for full order history");
  await expect(page.getByTestId("import-history")).toHaveCount(0);

  // The menu: the last 6 and 12 months, and each year from the store's first.
  const dates = page.getByLabel("Dates");
  await expect(dates.locator("option", { hasText: "Last 6 months" })).toHaveCount(1);
  await expect(dates.locator("option", { hasText: "Last 12 months" })).toHaveCount(1);
  await expect(dates.locator("optgroup[label='Calendar years'] option")).toHaveText(
    Array.from({ length: new Date().getUTCFullYear() - 2021 }, (_, i) => String(new Date().getUTCFullYear() - i)),
  );

  await dates.selectOption({ label: "2024" });
  await expect(page.getByTestId("shown-dates")).toContainText("2024");
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2024-01-01");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("2024-12-31");
  // 2024 lies before the orders Shopify shared: missing, not zero.
  await expect(page.getByTestId("history-gap")).toContainText("No orders from these dates have been imported");
  await expect(page.getByTestId("history-gap")).toContainText("not as days without sales");
  // The chart and the tiles say so too: no figures, never $0.
  await expect(page.getByTestId("trend-sales").getByRole("paragraph").filter({ hasText: "Not imported" })).toBeVisible();
  await expect(page.getByTestId("metric-Orders").getByTestId("figure-not-imported")).toBeVisible();
  // The year stands alone: no menu to compare it with other dates, and nothing saying it is.
  await expect(page.locator("div[title]", { has: page.locator("#date-range") })).not.toHaveAttribute("title", /Compared with/);
  await expect(page.getByLabel("Compare with")).toHaveCount(0);

  await page.getByRole("button", { name: "A year earlier" }).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2023-01-01");
  await expect(page.getByTestId("shown-dates")).toContainText("2023");
  // 2022 begins before the store did (14 Mar): nothing earlier to move to.
  await expect(page.getByRole("button", { name: "A year earlier" })).toBeDisabled();
  await page.getByRole("button", { name: "A year later" }).click();
  await expect(page.getByLabel("From", { exact: true })).toHaveValue("2024-01-01");

  // More than 12 months is said, with the latest end date, and not asked for.
  await page.getByLabel("To", { exact: true }).fill("2025-01-01");
  await expect(page.getByText("Pick up to 12 months at a time")).toBeVisible();
  await expect(page.getByTestId("shown-dates")).toContainText("2024");
  // Before the store's first day too.
  await page.getByLabel("To", { exact: true }).fill("2022-12-31");
  await page.getByLabel("From", { exact: true }).fill("2022-01-01");
  await expect(page.getByText("The store's first day is")).toBeVisible();
});
