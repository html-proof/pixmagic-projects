import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";

// The Orders & shipping tab (components/dashboard/SalesViews.tsx): every order placed in the dates,
// from GET …/orders, counted, in pages of 25, searchable by order number and filtered by payment.
const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

test("Orders & shipping lists every order in the dates, in pages, searchable and filtered", async ({ page }) => {
  await signUp(page, uniqueEmail("orders-list"));
  const ws = await createWorkspace(page, "Orders list");
  const store = await insertStore(db, ws, `orders-list-${Date.now()}.myshopify.com`);
  await db.query("UPDATE stores SET orders_history_from='1970-01-01', last_synced_at=now() WHERE id=$1", [store]);
  // Keep background refresh from trying to contact this deliberately offline fixture store.
  await db.query("INSERT INTO sync_jobs(id,workspace_id,store_id,kind,status,created_at,started_at,last_activity_at) VALUES(gen_random_uuid()::text,$1,$2,'shop','running',now(),now(),now())", [ws, store]);
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // 30 orders yesterday, #2001 to #2030, one minute apart; every fifth one still waiting for payment.
  await db.query(
    `INSERT INTO orders (id,workspace_id,store_id,shopify_id,name,currency,local_day,shopify_created_at,shopify_updated_at,shopify_processed_at,financial_status,subtotal,total_discounts,total_tax,total_shipping,total_price,source_name)
     SELECT gen_random_uuid()::text,$1,$2,'list-'||i,'#'||(2000+i),'USD',$3::text,$3::text::date+interval '9 hours'+i*interval '1 minute',now(),$3::text::date+interval '9 hours'+i*interval '1 minute',
            CASE WHEN i%5=0 THEN 'pending' ELSE 'paid' END,10*i,0,0,0,10*i,'web'
     FROM generate_series(1,30) i`,
    [ws, store, day],
  );

  await page.goto(`/dashboard?preset=custom&from=${day}&to=${day}&view=orders`);
  const list = page.getByTestId("sales-recent-orders");
  await expect(list.getByTestId("orders-count")).toContainText("30 orders", { timeout: 15_000 });
  await expect(list.locator("tbody tr")).toHaveCount(25);
  // Newest first, then the next page.
  await expect(list.locator("tbody tr").first()).toContainText("#2030");
  await list.getByTestId("orders-pager").getByRole("button", { name: "Next" }).click();
  await expect(list.locator("tbody tr")).toHaveCount(5);
  await expect(list.getByTestId("orders-pager")).toContainText("26–30 of 30");

  // Highest total first.
  await list.getByTestId("orders-sort").selectOption("total_desc");
  await expect(list.locator("tbody tr").first()).toContainText("$300.00");

  // An order number, with or without its "#".
  await list.getByTestId("orders-search").fill("2007");
  await expect(list.getByTestId("orders-count")).toContainText("1 matching order");
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list.locator("tbody tr").first()).toContainText("#2007");
  await list.getByTestId("orders-search").fill("");

  // Payment: the six still waiting.
  await list.getByTestId("orders-payment").selectOption("pending");
  await expect(list.getByTestId("orders-count")).toContainText("6 matching orders");
  await expect(list.locator("tbody tr")).toHaveCount(6);

  // On a phone: stacked rows, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list.locator("ul li").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
