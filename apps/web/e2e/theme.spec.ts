import { expect, test, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

/**
 * Light or dark mode (lib/theme.ts, components/Theme.tsx): dark is the app's own look, what
 * everyone sees until they choose otherwise. The choice is the person's, from the top bar's button
 * or Settings → Profile's Appearance card, kept on the device and applied to every page; "Same as
 * device" follows the device's own setting.
 */

const LIGHT_PAGE = "rgb(248, 249, 255)";
const DARK_PAGE = "rgb(18, 18, 17)";
const pageColour = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** One of the Appearance card's three choices. By the start of its name: each one's hint names the other palette's words. */
const choice = (page: Page, name: "Light" | "Dark" | "Same as device") => page.getByRole("group", { name: "Light or dark mode" }).getByRole("radio", { name: new RegExp(`^${name}`) });

test("the app is dark until someone chooses otherwise; the choice is kept on the device", async ({ page }) => {
  // A device set to light: the app is dark all the same, from the first page a visitor sees.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/login");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", "dark");
  expect(await pageColour(page)).toBe(DARK_PAGE);

  await signUp(page, uniqueEmail("theme"));
  await createWorkspace(page, "Theme Co");
  await page.goto("/settings/profile");
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(choice(page, "Dark")).toBeChecked();

  // The top bar's button: one click to light.
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(choice(page, "Light")).toBeChecked();
  await expect.poll(() => pageColour(page)).toBe(LIGHT_PAGE);
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();

  // Kept on the device: still light on another page of the app, after a reload, and on a page outside it.
  await page.getByRole("link", { name: "Security", exact: true }).first().click();
  await expect(page).toHaveURL(/\/settings\/security/);
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.goto("/terms");
  await expect(html).toHaveAttribute("data-theme", "light");

  // Same as device: the page follows the device's setting as it changes, and that choice is kept too.
  await page.goto("/settings/profile");
  await page.getByText("Same as device", { exact: true }).click();
  await expect(choice(page, "Same as device")).toBeChecked();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  await expect(choice(page, "Same as device")).toBeChecked();
  await expect(html).toHaveAttribute("data-theme", "light");

  // Back to dark, on a device set to light: the choice wins, and holds after a reload.
  await page.getByText("Dark", { exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => pageColour(page)).toBe(DARK_PAGE);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(choice(page, "Dark")).toBeChecked();
});
