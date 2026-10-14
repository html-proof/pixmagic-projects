import { expect, test, type Page } from "@playwright/test";
import { E2E_MAILPIT_URL } from "../playwright.config";
import { signUp, uniqueEmail, verifyEmailInEmulator } from "./helpers";

/**
 * Staff Management in a real browser against the real Worker: an owner adds an employee and
 * invites them; the invitation arrives by email; the employee sets a password and lands in the
 * portal; clocks in, survives a refresh, takes a break, clocks out; the owner approves the hours.
 * Payroll maths, permissions and isolation are covered in depth by apps/api/test/staff.test.ts.
 */

async function createWorkspace(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    if (!r.ok) throw new Error(`POST /workspaces failed: ${r.status}`);
    return ((await r.json()) as { workspace: { id: string } }).workspace.id;
  }, name);
}

async function owner(page: Page) {
  const email = uniqueEmail("staff-owner");
  await signUp(page, email);
  await verifyEmailInEmulator(email);
  await page.getByRole("button", { name: /verified my email/ }).click();
  await expect(page).toHaveURL(/onboarding/);
  const ws = await createWorkspace(page, "Corner Cafe");
  return { email, ws };
}

/** The newest email to `to` (plain text). */
async function latestMail(to: string): Promise<{ Subject: string; Text: string; HTML: string }> {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const id = ((await r.json()) as { messages?: Array<{ ID: string }> }).messages?.[0]?.ID;
    if (id) return (await (await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${id}`)).json()) as { Subject: string; Text: string; HTML: string };
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`no email to ${to}`);
}

const seconds = (t: string) => t.split(":").reduce((a, p) => a * 60 + Number(p), 0);

test("owner adds and invites an employee, who registers, clocks in and out, and gets approved", async ({ page, browser }) => {
  test.setTimeout(180_000);
  await owner(page);
  const employeeEmail = uniqueEmail("barista");

  // ---- Owner: add the employee
  await page.goto("/staff/employees/new");
  await page.getByLabel("Full name").fill("Jamie Rivera");
  await page.getByLabel("Email address").fill(employeeEmail);
  await page.getByLabel("Job title / position").fill("Barista");
  await page.getByLabel("Hourly rate").fill("24.50");
  await page.getByRole("button", { name: "Save employee" }).click();
  await expect(page.getByText("EMP-0001")).toBeVisible();
  await page.getByRole("button", { name: "Send invitation" }).click();

  // ---- The invitation email
  const mail = await latestMail(employeeEmail);
  expect(mail.Subject).toContain("Corner Cafe");
  expect(mail.Text).toContain("Barista");
  const link = /https?:\/\/\S+\/join\?token=[A-Za-z0-9_%-]+/.exec(mail.Text)?.[0];
  expect(link, "invitation link").toBeTruthy();
  expect(mail.Text).not.toContain("24.50");

  // ---- Employee (a separate browser): open the link, set a password
  const employeeContext = await browser.newContext();
  const emp = await employeeContext.newPage();
  await emp.goto(new URL(link!).pathname + new URL(link!).search);
  await expect(emp.getByText("Jamie Rivera")).toBeVisible();
  await expect(emp.getByText("Corner Cafe").first()).toBeVisible();
  await emp.getByLabel("Create password", { exact: true }).fill("Brew-Strong-Coffee-9");
  // Mismatched confirmation: the form says so and won't submit.
  await emp.getByLabel("Confirm password", { exact: true }).fill("Brew-Strong-Coffee-8");
  await expect(emp.getByText(/don.t match/i)).toBeVisible();
  await expect(emp.getByRole("button", { name: "Activate my account" })).toBeDisabled();
  await emp.getByLabel("Confirm password", { exact: true }).fill("Brew-Strong-Coffee-9");
  await emp.getByRole("button", { name: "Activate my account" }).click();
  await expect(emp).toHaveURL(/\/portal/, { timeout: 30_000 });
  await expect(emp.getByTestId("shift-status")).toContainText(/not clocked in/i);

  // The same link can't be used again.
  const reuse = await employeeContext.newPage();
  await reuse.goto(new URL(link!).pathname + new URL(link!).search);
  await expect(reuse.getByText(/already been used|no longer|isn.t valid|withdrawn/i).first()).toBeVisible();
  await reuse.close();

  // ---- Clock in; the timer survives a refresh
  await emp.getByRole("button", { name: "Clock in" }).click();
  await expect(emp.getByTestId("shift-status")).toContainText(/working/i);
  await emp.waitForTimeout(2_500);
  const before = seconds((await emp.getByTestId("shift-timer").innerText()).match(/\d+:\d{2}(:\d{2})?/)![0]);
  await emp.reload();
  await expect(emp.getByTestId("shift-status")).toContainText(/working/i);
  await expect
    .poll(async () => seconds((await emp.getByTestId("shift-timer").innerText()).match(/\d+:\d{2}(:\d{2})?/)![0]), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(before);

  // ---- Break
  await emp.getByRole("button", { name: "Start break" }).click();
  const meal = emp.getByRole("button", { name: /meal break/i });
  if (await meal.isVisible().catch(() => false)) await meal.click();
  await expect(emp.getByTestId("shift-status")).toContainText(/on break/i);
  await emp.getByRole("button", { name: "End break" }).click();
  await expect(emp.getByTestId("shift-status")).toContainText(/working/i);

  // ---- Clock out (confirm), summary shown
  await emp.getByRole("button", { name: "Clock out" }).click();
  const confirm = emp.getByRole("dialog").getByRole("button", { name: /clock out/i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(emp.getByTestId("shift-status")).toContainText(/not clocked in/i);

  // ---- Owner: the shift is waiting for review on the live board and in timesheets; approve it
  await page.goto("/staff/attendance");
  await expect(page.getByRole("cell", { name: /Jamie Rivera/ }).first()).toBeVisible();
  await page.goto("/staff/timesheets?status=pending");
  const row = page.getByRole("row", { name: /Jamie Rivera/ });
  await expect(row).toContainText("Waiting for review");
  await expect(row).toContainText("1 break");
  await row.getByRole("button", { name: "Approve", exact: true }).click();
  // Approved: it leaves the "waiting for review" list, and shows under Approved.
  await expect(page.getByRole("row", { name: /Jamie Rivera/ })).toHaveCount(0);
  await page.getByLabel("Status").selectOption({ label: "Approved" });
  await expect(page.getByRole("row", { name: /Jamie Rivera/ })).toContainText("Approved");

  // ---- The employee isn't a workspace member: the admin section sends them back to their portal
  await emp.goto("/staff");
  await expect(emp).toHaveURL(/\/portal/, { timeout: 15_000 });
  await employeeContext.close();
});
