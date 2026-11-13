import { expect, test, type Page } from "@playwright/test";
import { createWorkspace, signUp, uniqueEmail } from "./helpers";

/**
 * Light or dark mode (lib/theme.ts, components/Theme.tsx): the person's choice, from the top bar's
 * button or Settings → Profile's Appearance card, kept on the device and applied to every page;
 * "Same as device" follows the device's own setting, as the app did before there was a choice.
 */

const LIGHT_PAGE = "rgb(248, 249, 255)";
const DARK_PAGE = "rgb(18, 18, 17)";
const pageColour = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
/** One of the Appearance card's three choices. By the start of its name: each one's hint names the other palette's words. */
const choice = (page: Page, name: "Light" | "Dark" | "Same as device") => page.getByRole("group", { name: "Light or dark mode" }).getByRole("radio", { name: new RegExp(`^${name}`) });

test("light or dark is the person's choice, kept on the device, and can follow the device again", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, uniqueEmail("theme"));
  await createWorkspace(page, "Theme Co");
  await page.goto("/settings/profile");
  const html = page.locator("html");

  // Nothing chosen yet: the device's setting, and the card says so.
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(choice(page, "Same as device")).toBeChecked();
  expect(await pageColour(page)).toBe(LIGHT_PAGE);

  // The top bar's button: one click to dark, on a device set to light.
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(choice(page, "Dark")).toBeChecked();
  await expect.poll(() => pageColour(page)).toBe(DARK_PAGE);
  await expect(page.getByRole("button", { name: "Switch to light mode" })).toBeVisible();

  // Kept on the device: still dark after a reload, and on a page outside the signed-in app.
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "dark");
  await expect(choice(page, "Dark")).toBeChecked();
  await page.goto("/terms");
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Back to the device's setting, which the page then follows as it changes.
  await page.goto("/settings/profile");
  await page.getByText("Same as device", { exact: true }).click();
  await expect(choice(page, "Same as device")).toBeChecked();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html).toHaveAttribute("data-theme", "dark");

  // Light, chosen on a device set to dark: the choice wins, and holds after a reload.
  await page.getByText("Light", { exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect.poll(() => pageColour(page)).toBe(LIGHT_PAGE);
  await page.reload();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(choice(page, "Light")).toBeChecked();
});
