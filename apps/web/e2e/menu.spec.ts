import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_ENV } from "../playwright.config";
import { createWorkspace, insertStore, openMenuGroup, showEveryPage, signUp, uniqueEmail } from "./helpers";

/**
 * Finding your way around: the short menu (the everyday pages listed, the rest folded into groups
 * that open with a click, every page still there by its name), the sidebar narrowed to its icons,
 * the look around offered to a new device, and the "i" that says what a figure measures.
 */

const db = new pg.Pool({ connectionString: E2E_ENV.OWNER_DATABASE_URL });
test.afterAll(() => db.end());

const sidebar = (page: Page) => page.getByRole("complementary").getByRole("navigation", { name: "App" });

/** An owner whose store sold something today, so the Home has its numbers. */
async function ownerWithSales(page: Page, prefix: string) {
  await signUp(page, uniqueEmail(prefix));
  const ws = await createWorkspace(page, "Menu Co");
  const storeId = await insertStore(db, ws, `${prefix}-${Date.now()}.myshopify.com`);
  await db.query(
    `INSERT INTO daily_store_metrics (workspace_id, store_id, day, gross_sales, discounts, refunds, shipping, taxes, total_sales, orders, units, orders_with_customer, returning_customer_orders, refunded_orders)
     VALUES ($1, $2, $3, 500, 0, 0, 0, 0, 500, 2, 2, 0, 0, 0)`,
    [ws, storeId, new Date().toISOString().slice(0, 10)],
  );
}

test("the menu lists the everyday pages, folds the rest, and every page is still there by its name", async ({ page }) => {
  await ownerWithSales(page, "menu");
  await page.goto("/dashboard");
  const nav = sidebar(page);
  await expect(nav).toHaveAttribute("data-menu", "short");

  // The everyday pages are listed; the others wait in their groups.
  for (const name of ["Dashboard", "Sales & Orders", "Products", "Customers", "Advertising"]) await expect(nav.getByRole("link", { name, exact: true }), name).toBeVisible();
  for (const name of ["Orders", "Shipping", "Business Overview", "Integrations", "Team & Access"]) await expect(nav.getByRole("link", { name, exact: true }), name).toHaveCount(0);

  // A group opens with a click, and is still open after a reload: the device remembers.
  const store = nav.getByTestId("menu-group-store");
  await expect(store).toHaveAttribute("aria-expanded", "false");
  await store.click();
  await expect(store).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "Orders", exact: true })).toBeVisible();
  await page.reload();
  await expect(nav.getByRole("link", { name: "Orders", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Integrations", exact: true })).toHaveCount(0);

  // A page reached another way shows in its own group, open by itself; closing it by hand hides it.
  await page.goto("/team");
  const team = nav.getByRole("link", { name: "Team & Access", exact: true });
  await expect(team).toHaveAttribute("aria-current", "page");
  const settings = nav.getByTestId("menu-group-settings");
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await settings.click();
  await expect(team).toHaveCount(0);
  await settings.click();
  await expect(team).toBeVisible();

  // "Show every page" brings back the whole list, kept on the device; "Show fewer pages" returns.
  await showEveryPage(page);
  for (const name of ["Business Overview", "Orders", "Shipping", "Sales channels", "Integrations", "Team & Access"]) await expect(nav.getByRole("link", { name, exact: true }), name).toBeVisible();
  await expect(nav.getByTestId("menu-group-store")).toHaveCount(0);
  await page.reload();
  await expect(nav).toHaveAttribute("data-menu", "full");
  await nav.getByTestId("menu-layout-switch").click();
  await expect(nav).toHaveAttribute("data-menu", "short");
  await expect(nav.getByRole("link", { name: "Business Overview", exact: true })).toHaveCount(0);

  // A folded page opens as it always did.
  await openMenuGroup(page, "reports");
  await nav.getByRole("link", { name: "Business Overview", exact: true }).click();
  await expect(page).toHaveURL(/view=overview/);
  await expect(nav.getByRole("link", { name: "Business Overview", exact: true })).toHaveAttribute("aria-current", "page");
});

test("the sidebar narrows to its icons and widens again", async ({ page }) => {
  await ownerWithSales(page, "rail");
  await page.goto("/dashboard");
  const aside = page.getByRole("complementary");
  const nav = sidebar(page);
  await expect(aside).toHaveAttribute("data-rail", "off");
  const wide = (await aside.boundingBox())!.width;

  await aside.getByRole("button", { name: "Narrow the menu to icons" }).click();
  await expect(aside).toHaveAttribute("data-rail", "on");
  expect((await aside.boundingBox())!.width).toBeLessThan(wide / 2);
  // Every icon keeps its page's name, for a screen reader and on hover.
  const sales = nav.getByRole("link", { name: "Sales & Orders", exact: true });
  await expect(sales).toHaveAttribute("title", "Sales & Orders");
  // Kept on the device.
  await page.reload();
  await expect(aside).toHaveAttribute("data-rail", "on");

  // A group's icon widens the menu with that group open.
  await nav.getByRole("button", { name: "Store: show its pages" }).click();
  await expect(aside).toHaveAttribute("data-rail", "off");
  await expect(nav.getByRole("link", { name: "Orders", exact: true })).toBeVisible();

  // The icons still take you there.
  await aside.getByRole("button", { name: "Narrow the menu to icons" }).click();
  await sales.click();
  await expect(page).toHaveURL(/view=sales/);
  await aside.getByRole("button", { name: "Widen the menu" }).click();
  await expect(aside).toHaveAttribute("data-rail", "off");
});

test("a new device is offered a look around: it can be taken, left at any step, declined, and found again under help", async ({ page }) => {
  await ownerWithSales(page, "tour");
  await page.goto("/dashboard");
  const offer = page.getByTestId("tour-offer");
  await expect(offer).toContainText("New here?");
  // Offered, never started by itself.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await offer.getByRole("button", { name: "Show me around" }).click();
  const tour = page.getByRole("dialog");
  await expect(tour.getByRole("heading")).toHaveText("Your numbers at a glance");
  await expect(tour.getByTestId("tour-count")).toHaveText(/^1 of \d$/);
  await expect(page.getByTestId("tour-spotlight")).toBeVisible();
  await expect(offer).toHaveCount(0);
  await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByRole("heading")).toHaveText("Choose the dates");
  await tour.getByRole("button", { name: "Back" }).click();
  await expect(tour.getByRole("heading")).toHaveText("Your numbers at a glance");
  // The keyboard works it too, and Escape leaves at any step.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(tour.getByRole("heading")).toHaveText("Everything else is in the menu");
  await page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);

  // Not offered again on this device…
  await page.reload();
  await expect(page.getByTestId("metric-Total sales")).toBeVisible();
  await expect(offer).toHaveCount(0);

  // …but always there under the help button, through to its last step.
  await page.getByRole("button", { name: "Help and support" }).click();
  await page.getByRole("button", { name: "Show me around" }).click();
  await expect(tour.getByRole("heading")).toHaveText("Your numbers at a glance");
  const steps = Number((await tour.getByTestId("tour-count").innerText()).split(" of ")[1]);
  expect(steps).toBeGreaterThanOrEqual(6);
  for (let i = 1; i < steps; i++) await tour.getByRole("button", { name: "Next" }).click();
  await expect(tour.getByRole("heading")).toHaveText("Help is always here");
  await tour.getByRole("button", { name: "Done" }).click();
  await expect(tour).toHaveCount(0);
  // Nothing on the page was changed by it.
  await expect(page).toHaveURL(/\/dashboard\/?$/);

  // "No thanks" is an answer too: the offer goes and no tour opens.
  await page.evaluate(() => window.localStorage.removeItem("tour-seen"));
  await page.reload();
  await offer.getByRole("button", { name: "No thanks" }).click();
  await expect(offer).toHaveCount(0);
  await expect(tour).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("metric-Total sales")).toBeVisible();
  await expect(offer).toHaveCount(0);
});

test("the i beside a figure on the Sales page says what it measures", async ({ page }) => {
  await ownerWithSales(page, "help");
  await page.goto("/dashboard");
  await expect(page.getByTestId("metric-Total sales")).toContainText("$500.00");
  await page.getByTestId("metric-Total sales").click();
  await expect(page).toHaveURL(/view=sales/);

  const figure = page.getByTestId("sales-figure-Total sales");
  const i = figure.getByRole("button", { name: "What is Total sales?" });
  const note = figure.getByRole("tooltip").filter({ hasText: "Everything customers were charged" });
  await expect(note).toBeHidden();
  await i.click();
  await expect(note).toBeVisible();
  await expect(note).toContainText("The same figure as Shopify's Total sales.");
  await page.keyboard.press("Escape");
  await expect(note).toBeHidden();
  // By keyboard: focus shows it, and leaving hides it.
  await i.blur();
  await i.focus();
  await expect(note).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(note).toBeHidden();
});
