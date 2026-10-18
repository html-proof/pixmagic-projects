import { expect, test, type Page } from "@playwright/test";
import { signUp, uniqueEmail } from "./helpers";

/**
 * A pay run's page in a real browser: its totals, the pay per employee (with the breakdown of
 * one row), adding and removing an earning, and the approval workflow from draft to approved.
 * The figures themselves are tested in depth by apps/api/test/staff.test.ts; the setup here goes
 * through the API so the test is about the page.
 */

async function apiCall<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${await r.text()}`);
      return r.json();
    },
    { method, path, body },
  ) as Promise<T>;
}

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("a pay run: totals, pay per employee, an earning added and removed, sent for approval and approved", async ({ page }) => {
  test.setTimeout(120_000);
  await signUp(page, uniqueEmail("payroll-owner"));
  const { workspace } = await apiCall<{ workspace: { id: string } }>(page, "POST", "/workspaces", { name: "Corner Cafe" });
  const ws = workspace.id;
  await apiCall(page, "PUT", `/workspaces/${ws}/staff/settings`, { timezone: "UTC" });

  // One employee at A$20 an hour, with one approved 8-hour shift a week ago.
  const { employee } = await apiCall<{ employee: { id: string } }>(page, "POST", `/workspaces/${ws}/staff/employees`, {
    fullName: "Jamie Rivera",
    email: uniqueEmail("barista"),
    jobTitle: "Barista",
    employmentType: "full_time",
    joinedOn: day(-30),
    standardWeeklyMinutes: 2400,
    workingDays: [1, 2, 3, 4, 5],
    hourlyRate: "20",
  });
  const shiftDay = day(-7);
  const { session } = await apiCall<{ session: { id: string } }>(page, "POST", `/workspaces/${ws}/staff/employees/${employee.id}/shifts`, {
    clockInAt: `${shiftDay}T09:00:00.000Z`,
    clockOutAt: `${shiftDay}T17:00:00.000Z`,
    note: "Forgot to clock in",
  });
  await apiCall(page, "POST", `/workspaces/${ws}/staff/timesheets/approve`, { sessionIds: [session.id] });
  const { period } = await apiCall<{ period: { id: string } }>(page, "POST", `/workspaces/${ws}/staff/payroll/periods`, { startDate: day(-9), endDate: day(-5) });
  await apiCall(page, "POST", `/workspaces/${ws}/staff/payroll/periods/${period.id}/calculate`, {});

  await page.goto(`/staff/payroll/period?id=${period.id}`);
  await expect(page.getByRole("heading", { name: /^Pay run:/ })).toBeVisible();
  const totals = page.getByRole("region", { name: "Totals" });
  await expect(totals.getByText("Gross pay", { exact: true }).first()).toBeVisible();
  await expect(totals.getByText("160.00").first()).toBeVisible();

  // The employee's row, and the breakdown it opens.
  const items = page.getByRole("table", { name: "Pay per employee" });
  await expect(items.getByText("Jamie Rivera", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Show details for Jamie Rivera" }).click();
  await expect(page.getByText(/How the gross pay adds up \(1 shift\)/).first()).toBeVisible();
  await page.getByRole("button", { name: "Hide details for Jamie Rivera" }).click();
  await expect(page.getByText(/How the gross pay adds up/)).toHaveCount(0);

  // An earning, added and removed again.
  await page.getByRole("button", { name: "Add earning or deduction" }).click();
  const modal = page.getByRole("dialog", { name: "Add earning or deduction" });
  await modal.getByLabel("Employee").selectOption({ label: "Jamie Rivera (EMP-0001)" });
  await modal.getByLabel("Name").fill("Weekend bonus");
  await modal.getByLabel(/^Amount/).fill("25");
  await modal.getByRole("button", { name: "Add", exact: true }).click();
  const adjustments = page.getByRole("region", { name: "Earnings and deductions" });
  await expect(adjustments.getByText("Weekend bonus", { exact: true }).first()).toBeVisible();
  await expect(totals.getByText("185.00").first()).toBeVisible();
  await adjustments.getByRole("button", { name: "Remove Weekend bonus" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(adjustments.getByText("None for this pay run.")).toBeVisible();

  // The workflow: sent for approval, then approved (an owner may approve their own).
  await page.getByRole("button", { name: "Send for approval" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByText("Sent for approval.").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve payroll" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve payroll" }).click();
  await expect(page.getByText("Hours and figures locked").first()).toBeVisible();
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText("Sent for approval").first()).toBeVisible();
  await expect(history.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/We couldn.t load|ran into a problem/)).toHaveCount(0);
});
