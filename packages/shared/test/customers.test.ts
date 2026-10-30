import { describe, expect, it } from "vitest";
import { acquiredTotals, addMonths, cohortGrid, customerFigures, customerHistoryStart, customersKnownDay, monthIndex, monthsBetween, perCustomer, type CohortCount, type CustomerDay } from "../src/customers";

describe("calendar months", () => {
  it("counts months across a year's end", () => {
    expect(monthIndex("2026-12-31") + 1).toBe(monthIndex("2027-01-01"));
    expect(monthsBetween("2026-12-30", "2027-01-02")).toBe(1);
    expect(monthsBetween("2026-01-31", "2026-01-01")).toBe(0);
    expect(monthsBetween("2025-11", "2027-02")).toBe(15);
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2027-01", -1)).toBe("2026-12");
    expect(addMonths("2026-10", -23)).toBe("2024-11");
  });

  it("has no figure per customer without customers", () => {
    expect(perCustomer(10, 0)).toBeNull();
    expect(perCustomer(0, 4)).toBe(0);
    expect(perCustomer(9, 4)).toBe(2.25);
  });
});

describe("from when customers are known", () => {
  const known = (day: string, unlinkedBefore = false, unlinkedOn = false) => ({ day, unlinkedBefore, unlinkedOn });

  it("starts with the whole imported days when orders carried customers from the start", () => {
    // The import window started part way through 2 July: its orders on that day are linked too, but the day isn't whole.
    expect(customerHistoryStart("2026-07-03", known("2026-07-02", false, true))).toBe("2026-07-03");
    expect(customerHistoryStart("2026-07-03", known("2026-07-03", false, true))).toBe("2026-07-03");
    // A quiet start: no order at all before the first one with a customer.
    expect(customerHistoryStart("2026-07-03", known("2026-07-20"))).toBe("2026-07-03");
  });

  it("starts where orders began to carry customers when earlier ones carry none (read_customers granted since)", () => {
    // That first day's orders all have one: from that day.
    expect(customerHistoryStart("2026-03-01", known("2026-08-14", true, false))).toBe("2026-08-14");
    // Some of that day's orders have none (read before the re-read's starting moment): from the day after.
    expect(customerHistoryStart("2026-03-01", known("2026-08-14", true, true))).toBe("2026-08-15");
    expect(customerHistoryStart("2026-03-01", known("2026-08-14", false, true))).toBe("2026-08-15");
  });

  it("is unknown without imported days or without a known customer", () => {
    expect(customerHistoryStart(null, known("2026-08-14"))).toBeNull();
    expect(customerHistoryStart("2026-03-01", null)).toBeNull();
  });

  it("takes a quiet start's first day with a guest among its orders as linked when the window's partial day was", () => {
    expect(customerHistoryStart("2026-07-03", { ...known("2026-07-06", false, true), linkedBefore: true })).toBe("2026-07-03");
    expect(customerHistoryStart("2026-07-03", known("2026-07-06", false, true))).toBe("2026-07-07");
    // Orders without a customer in between still decide.
    expect(customerHistoryStart("2026-07-03", { ...known("2026-07-06", true, true), linkedBefore: true })).toBe("2026-07-07");
  });
});

describe("the day orders began to carry their customer", () => {
  /** Days as daily_store_metrics has them: [day, orders, with a known customer]. */
  const days = (...d: Array<[string, number, number]>): CustomerDay[] => d.map(([day, orders, withCustomer]) => ({ day, orders, withCustomer }));
  /** Read before the grant: every order of 1 June to 19 August without a customer; re-read from part way through 20 August. */
  const granted = days(["2026-06-05", 3, 0], ["2026-06-20", 2, 0], ["2026-07-15", 4, 0], ["2026-08-01", 1, 0], ["2026-08-20", 3, 1], ["2026-08-25", 2, 2], ["2026-09-02", 5, 4], ["2026-09-10", 1, 0], ["2026-09-12", 2, 2]);
  const start = (d: CustomerDay[], wholeFrom = "2026-06-01") => customerHistoryStart(wholeFrom, customersKnownDay(d, wholeFrom));

  it("starts where the orders began to carry one, and a guest-only day after that doesn't move it", () => {
    expect(customersKnownDay(granted, "2026-06-01")).toEqual({ day: "2026-08-20", unlinkedBefore: true, unlinkedOn: true, linkedBefore: false });
    expect(start(granted)).toBe("2026-08-21");
  });

  it("isn't moved earlier by one order linked out of turn, inside the window or before it", () => {
    // An old order updated since the grant (or dated by when it was processed elsewhere) has its customer.
    expect(start([...granted, ...days(["2026-06-25", 1, 1])])).toBe("2026-08-21");
    expect(start([...granted, ...days(["2026-05-10", 1, 1])])).toBe("2026-08-21");
  });

  it("starts with the window when orders carried customers from the start", () => {
    const linked = days(["2026-07-02", 2, 2], ["2026-07-06", 3, 2], ["2026-07-07", 1, 0], ["2026-07-09", 2, 2]);
    // The window began part way through 2 July; a quiet start, then a guest among the first day's orders.
    expect(start(linked, "2026-07-03")).toBe("2026-07-03");
    // With nothing before the window to say so, that guest is read as the grant's starting moment: a day late, never early.
    expect(start(linked.slice(1), "2026-07-03")).toBe("2026-07-07");
  });

  it("has no start before an order with a customer", () => {
    expect(customersKnownDay(days(["2026-07-05", 3, 0]), "2026-07-03")).toBeNull();
    expect(customersKnownDay([], "2026-07-03")).toBeNull();
  });
});

describe("figures per customer", () => {
  const t = { customers: 4, repeatCustomers: 1, orders: 6, netSales: 100.005 };

  it("shows customer counts to everyone allowed, orders and money only when asked", () => {
    expect(customerFigures(t)).toEqual({ customers: 4, repeatCustomers: 1, repeatRate: 0.25 });
    expect(customerFigures(t, { orders: true })).toEqual({ customers: 4, repeatCustomers: 1, repeatRate: 0.25, orders: 6, ordersPerCustomer: 1.5 });
    expect(customerFigures(t, { money: "shown" })).toMatchObject({ netSales: 100.01, netSalesPerCustomer: 25 });
    // Withheld: there, but unknown, not 0.
    expect(customerFigures(t, { money: "withheld" })).toMatchObject({ netSales: null, netSalesPerCustomer: null });
  });

  it("has rates of nothing as null", () => {
    expect(customerFigures({ customers: 0, repeatCustomers: 0, orders: 0, netSales: 0 }, { orders: true, money: "shown" })).toEqual({
      customers: 0,
      repeatCustomers: 0,
      repeatRate: null,
      orders: 0,
      ordersPerCustomer: null,
      netSales: 0,
      netSalesPerCustomer: null,
    });
  });
});

describe("monthly first-order cohorts", () => {
  // November: 2 customers, one back in November and January. December: 1 customer, back in January.
  const rows: CohortCount[] = [
    { cohort: "2026-11", month: null, firstBuyers: 2, returned: 1, orders: 4, netSales: 200 },
    { cohort: "2026-11", month: "2026-11", firstBuyers: 2, returned: 1, orders: 3, netSales: 150 },
    { cohort: "2026-11", month: "2027-01", firstBuyers: 0, returned: 1, orders: 1, netSales: 50 },
    { cohort: "2026-12", month: null, firstBuyers: 1, returned: 1, orders: 2, netSales: 30 },
    { cohort: "2026-12", month: "2026-12", firstBuyers: 1, returned: 0, orders: 1, netSales: 20 },
    { cohort: "2026-12", month: "2027-01", firstBuyers: 0, returned: 1, orders: 1, netSales: 10 },
  ];
  const at = { today: "2027-01-20", from: "2026-11-10", customersFrom: "2026-11-10" };

  it("lists the months newest first, with a cell up to the current month and none after", () => {
    const grid = cohortGrid(rows, at);
    expect(grid.map((c) => [c.month, c.customers, c.cells.length])).toEqual([
      ["2027-01", 0, 1],
      ["2026-12", 1, 2],
      ["2026-11", 2, 3],
    ]);
    const nov = grid[2]!;
    expect(nov.cells.map((c) => [c.n, c.month, c.returned, c.rate, c.running])).toEqual([
      [0, "2026-11", 1, 0.5, false],
      // A month nobody came back in: a real 0, the orders of that month are all in.
      [1, "2026-12", 0, 0, false],
      [2, "2027-01", 1, 0.5, true],
    ]);
    expect(nov).toMatchObject({ repeatCustomers: 1, repeatRate: 0.5 });
    // No money or orders unless asked for.
    expect(nov).not.toHaveProperty("netSalesPerCustomer");
    expect(nov).not.toHaveProperty("ordersPerCustomer");
    expect(nov.cells[0]).not.toHaveProperty("netSalesPerCustomerToDate");
  });

  it("has no rate for a month without first buyers", () => {
    const jan = cohortGrid(rows, at)[0]!;
    expect(jan).toMatchObject({ month: "2027-01", customers: 0, repeatRate: null });
    expect(jan.cells).toEqual([{ n: 0, month: "2027-01", returned: 0, rate: null, running: true }]);
  });

  it("marks the cohort whose month began before customers are known", () => {
    const grid = cohortGrid(rows, at);
    expect(grid.map((c) => c.partial)).toEqual([false, false, true]);
    // From the first of the month: whole.
    expect(cohortGrid(rows, { ...at, from: "2026-11-01", customersFrom: "2026-11-01" }).map((c) => c.partial)).toEqual([false, false, false]);
  });

  it("adds up net sales per customer month by month, first orders included", () => {
    const nov = cohortGrid(rows, { ...at, money: "shown", orders: true })[2]!;
    expect(nov.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([75, 75, 100]);
    expect(nov).toMatchObject({ netSalesPerCustomer: 100, ordersPerCustomer: 2 });
    const withheld = cohortGrid(rows, { ...at, money: "withheld" })[2]!;
    expect(withheld.netSalesPerCustomer).toBeNull();
    expect(withheld.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([null, null, null]);
  });

  it("withholds net sales only of a cohort with orders whose sales aren't read", () => {
    const unread = rows.map((r) => (r.cohort === "2026-11" && r.month === null ? { ...r, unreadSales: 1 } : r));
    const [, dec, nov] = cohortGrid(unread, { ...at, money: "shown" });
    expect(nov!.netSalesPerCustomer).toBeNull();
    expect(nov!.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([null, null, null]);
    expect(dec!.netSalesPerCustomer).toBe(30);
    expect(dec!.cells.map((c) => c.netSalesPerCustomerToDate)).toEqual([20, 30]);
  });

  it("lists at most the months asked for, and never more than 24", () => {
    expect(cohortGrid(rows, { ...at, months: 2 }).map((c) => c.month)).toEqual(["2027-01", "2026-12"]);
    const long = cohortGrid([], { today: "2027-01-20", from: "2020-01-01", customersFrom: "2020-01-01", months: 100 });
    expect(long).toHaveLength(24);
    expect(long.at(-1)!.month).toBe("2025-02");
    expect(long.at(-1)!.cells).toHaveLength(24);
  });

  it("adds the cohorts shown up to everyone who first bought since", () => {
    const grid = cohortGrid(rows, { ...at, months: 2 });
    expect(acquiredTotals(rows, grid)).toEqual({ customers: 1, repeatCustomers: 1, orders: 2, netSales: 30 });
    expect(acquiredTotals(rows, cohortGrid(rows, at))).toEqual({ customers: 3, repeatCustomers: 2, orders: 6, netSales: 230 });
  });
});
