import { expect, test } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, signUp, uniqueEmail } from "./helpers";
const db = new pg.Pool({ connectionString: E2E_ENV.DATABASE_URL });
test.afterAll(() => db.end());

test("top products ranks real sales before paging, sorts, searches, exports and shows variant details", async ({page}, testInfo) => {
  await signUp(page, uniqueEmail("product-ranking"));
  const ws = await createWorkspace(page, "Product rankings");
  const store = await insertStore(db, ws, `ranking-${Date.now()}.myshopify.com`);
  await db.query("UPDATE stores SET orders_history_from='1970-01-01', last_synced_at=now() WHERE id=$1", [store]);
  // Keep background refresh from trying to contact this deliberately offline fixture store.
  await db.query("INSERT INTO sync_jobs(id,workspace_id,store_id,kind,status,created_at,started_at,last_activity_at) VALUES(gen_random_uuid()::text,$1,$2,'shop','running',now(),now(),now())", [ws,store]);
  const day = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const order = (await db.query(`INSERT INTO orders (id,workspace_id,store_id,shopify_id,name,currency,local_day,shopify_created_at,shopify_updated_at,shopify_processed_at,sales_updated_at,traffic_source,subtotal,total_discounts,total_tax,total_shipping,total_price)
    VALUES(gen_random_uuid()::text,$1,$2,'rank-order','#rank-order','USD',$3::text,$3::text::date+interval '12 hours',$3::text::date+interval '12 hours',$3::text::date+interval '12 hours',now(),'direct',88740,0,0,0,88740) RETURNING id`, [ws,store,day])).rows[0].id;
  await db.query(`INSERT INTO order_line_items(id,workspace_id,store_id,order_id,shopify_id,product_shopify_id,variant_shopify_id,sku,title,quantity,price,discount)
    SELECT gen_random_uuid()::text,$1,$2,$3,'line-'||i,'p'||i,'v'||i,'sku-'||i,'Product '||i,i,CASE WHEN i=1 THEN 10000 ELSE 10 END,0 FROM generate_series(1,125) i`, [ws,store,order]);
  await db.query(`INSERT INTO order_sales(id,workspace_id,store_id,order_id,shopify_id,local_day,happened_at,action_type,line_type,line_item_shopify_id,quantity,amount,discount,tax)
    SELECT gen_random_uuid()::text,$1,$2,$3,'sale-'||i,$4::text,$4::text::date+interval '12 hours','order','product','line-'||i,i,CASE WHEN i=1 THEN 10000 ELSE i*10 END,0,0 FROM generate_series(1,125) i`, [ws,store,order,day]);
  await page.goto(`/dashboard?preset=custom&from=${day}&to=${day}&view=products`);
  const panel = page.locator("#d-top-products");
  await expect(panel.getByRole("heading", {name:"Top 100 products"})).toBeVisible();
  await expect(panel.locator("tbody tr")).toHaveCount(10);
  await expect(panel.locator("tbody tr").first()).toContainText("Product 125");
  await panel.getByRole("button", {name:"Next",exact:true}).click();
  await expect(panel.locator("tbody tr").first()).toContainText("Product 115");
  await panel.getByLabel("Rows", {exact:true}).selectOption("100");
  await expect(panel.locator("tbody tr")).toHaveCount(100);
  await page.screenshot({path:testInfo.outputPath("top-products-desktop.png"),fullPage:true});
  const download = page.waitForEvent("download");
  await panel.getByRole("button", {name:"Export CSV"}).click();
  expect((await download).suggestedFilename()).toContain("top-products-");
  await panel.getByLabel("Ranking", {exact:true}).selectOption("revenue");
  await expect(panel.locator("tbody tr").first()).toContainText("Product 1");
  await panel.getByLabel("Search", {exact:true}).fill("p125");
  await expect(panel.locator("tbody tr")).toHaveCount(1);
  await panel.getByRole("button", {name:"View Product 125", exact:true}).click();
  await expect(panel.getByLabel("Product 125 details")).toContainText("Gross units: 125");
  await expect(panel.getByLabel("Product 125 details")).toContainText("sku-125");
  await page.setViewportSize({width:390,height:844});
  await expect(panel.getByRole("table")).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("top-products-mobile.png"),fullPage:true});
});
