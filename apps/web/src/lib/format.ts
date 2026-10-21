export const fmtMoney = (n: number | null | undefined, currency = "USD") =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
export const fmtPct = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(n);
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? "—" : new Intl.NumberFormat().format(n));
