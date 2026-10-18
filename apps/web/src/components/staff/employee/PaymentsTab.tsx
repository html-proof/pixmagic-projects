"use client";
/** The Payment History tab: payments recorded to the employee and what each one paid off. */
import { useState } from "react";
import { PAYMENT_METHOD_LABEL, type PaymentMethod, type PaymentStatus } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { useAction } from "@/components/AppUi";
import { Figure, Pagination, PaymentBadge, Table, Td, Th } from "@/components/staff/ui";
import { useApi } from "@/lib/api";
import { exportFile, fmtDay, fmtMoney, fmtSpan, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

const enc = encodeURIComponent;

interface PaymentItem {
  id: string;
  amount: string;
  currency: string;
  paidOn: string;
  method: PaymentMethod;
  reference: string | null;
  remarks: string | null;
  status: PaymentStatus;
  statusReason: string | null;
  recordedBy: string | null;
  allocations: Array<{ payrollItemId: string; amount: string; period: { id: string; from: string; to: string; status: string }; itemNet: string; itemOutstanding: string }>;
}
interface PaymentList {
  total: number;
  page: number;
  pageSize: number;
  totals: Array<{ currency: string; status: PaymentStatus; count: number; amount: string }>;
  items: PaymentItem[];
}

const PAYMENTS_PAGE = 100;

export function PaymentsTab({ employee, config }: { employee: EmployeeRow; config: StaffConfig }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const [page, setPage] = useState(1);
  const list = useApi<PaymentList>(`${base}/payroll/payments?employeeId=${enc(employee.id)}&page=${page}&pageSize=${PAYMENTS_PAGE}`);
  const download = () =>
    run("statement", "download the statement", async () => {
      await exportFile(base, { kind: "statement", employeeId: employee.id, preset: "this_year" });
      return "Statement downloaded.";
    });
  const paid = (list.data?.totals ?? []).filter((t) => t.status === "completed");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          {paid.map((t) => (
            <Figure key={t.currency} label={`Paid (${t.count} ${t.count === 1 ? "payment" : "payments"})`} value={fmtMoney(t.amount, t.currency)} />
          ))}
        </div>
        {can("staff:export") && (
          <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void download()}>
            {busy === "statement" ? "Preparing…" : "Download statement (PDF)"}
          </button>
        )}
      </div>
      {list.error ? (
        <LoadError what="payment history" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-40" aria-busy="true" aria-label="Loading" />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">No payments recorded for {employee.fullName} yet. Payments are recorded from approved payroll.</p>
      ) : (
        <>
          <Table label="Payment history">
            <thead>
              <tr>
                <Th>Paid on</Th>
                <Th>Pay period</Th>
                <Th right>Amount</Th>
                <Th>Method</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th right>Still owed</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((p) => (
                <tr key={p.id}>
                  <Td className="whitespace-nowrap">{fmtDay(p.paidOn)}</Td>
                  <Td className="whitespace-nowrap">
                    {p.allocations.map((a) => (
                      <p key={a.payrollItemId}>{fmtSpan(a.period.from, a.period.to)}</p>
                    ))}
                  </Td>
                  <Td right>{fmtMoney(p.amount, p.currency)}</Td>
                  <Td>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</Td>
                  <Td>
                    {p.reference ?? <span className="text-muted">—</span>}
                    {p.remarks && <p className="text-xs text-muted">{p.remarks}</p>}
                  </Td>
                  <Td>
                    <PaymentBadge status={p.status} />
                    {p.statusReason && <p className="mt-1 text-xs text-muted">{p.statusReason}</p>}
                  </Td>
                  <Td right>
                    {p.allocations.map((a) => (
                      <p key={a.payrollItemId} className={Number(a.itemOutstanding) > 0 ? "text-warn" : "text-muted"}>
                        {fmtMoney(a.itemOutstanding, p.currency)}
                      </p>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
          <p className="text-xs text-muted">&ldquo;Still owed&rdquo; is what remains unpaid on that pay period now, after every payment recorded against it. Dates are in {config.settings.timezone}.</p>
        </>
      )}
    </div>
  );
}
