/** A pay run as the API returns it, and the wording its page uses: workflow steps, history, payment status, warnings. */
import type { PayCategory, PayCycle, PayrollStatus } from "@app/shared/staff";
import type { Tone } from "@/components/dashboard/Primitives";
import { fmtHoursDec } from "@/lib/staff";

type MoneyTotals = { gross: string; otherEarnings: string; deductions: string; net: string; paid: string; outstanding: string };

interface PayLine {
  category: PayCategory;
  hourlyRate: string;
  multiplier: string;
  seconds: number;
  amount: string;
}

type ItemPaymentStatus = "nothing_owed" | "paid" | "partially_paid" | "failed" | "unpaid";

export interface Item {
  id: string;
  employee: { id: string; fullName: string; employeeNumber: string; jobTitle: string; department: string | null };
  currency: string;
  regularSeconds: number;
  overtimeSeconds: number;
  doubleTimeSeconds: number;
  holidaySeconds: number;
  paidBreakSeconds: number;
  unpaidBreakSeconds: number;
  unpricedSeconds: number;
  gross: string;
  otherEarnings: string;
  deductions: string;
  net: string;
  paid: string;
  outstanding: string;
  paymentStatus: ItemPaymentStatus;
  lines: PayLine[];
  warnings: string[];
  shifts: number;
}

export interface Adjustment {
  id: string;
  employeeId: string;
  kind: "earning" | "deduction";
  label: string;
  amount: string;
  currency: string;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}

export interface Issue {
  code: string;
  message: string;
  count: number;
  employees: string[];
}

export interface Period {
  id: string;
  startDate: string;
  endDate: string;
  payDate: string | null;
  payCycle: PayCycle;
  status: PayrollStatus;
  version: number;
  calculatedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  locked: boolean;
  notes: string | null;
  employees: number;
  regularSeconds: number;
  overtimeSeconds: number;
  breakSeconds: number;
  totals: Record<string, MoneyTotals>;
  timezone: string;
  issues: Issue[];
  items: Item[];
  adjustments: Adjustment[];
  history: Array<{ id: string; action: string; version: number; by: string; comment: string | null; at: string }>;
  estimateNotice: string;
}

export type Flow = "submit" | "approve" | "reject" | "cancel" | "reverse";

export const FLOW: Record<Flow, { title: string; confirm: string; body: string; comment: string; required: boolean; danger: boolean; what: string; done: string }> = {
  submit: {
    title: "Send for approval?",
    confirm: "Send for approval",
    body: "bizinsights recalculates the figures with the latest hours first. Someone who may approve payroll then checks and approves them.",
    comment: "Note for the approver (optional)",
    required: false,
    danger: false,
    what: "send the payroll for approval",
    done: "Sent for approval.",
  },
  approve: {
    title: "Approve this payroll?",
    confirm: "Approve payroll",
    body: "Approving locks the hours and the figures for this period: its shifts can't be edited and the amounts won't change. Payments can then be recorded and payslips downloaded. If anything changed since the figures were calculated, nothing is approved and the payroll goes back for review.",
    comment: "Comment (optional)",
    required: false,
    danger: false,
    what: "approve the payroll",
    done: "Payroll approved. The hours and figures are now locked.",
  },
  reject: {
    title: "Send back for changes?",
    confirm: "Send back",
    body: "The payroll goes back to draft so the hours or adjustments can be corrected and the figures recalculated.",
    comment: "What needs to change",
    required: true,
    danger: true,
    what: "send the payroll back",
    done: "Sent back for changes.",
  },
  cancel: {
    title: "Cancel this pay run?",
    confirm: "Cancel pay run",
    body: "Nothing can be paid from a cancelled pay run, and its days can be included in a new one.",
    comment: "Reason (optional)",
    required: false,
    danger: true,
    what: "cancel the pay run",
    done: "Pay run cancelled.",
  },
  reverse: {
    title: "Reverse the approval?",
    confirm: "Reverse approval",
    body: "The figures are unlocked and the shifts can be edited again; the days can then be run again in a new pay run. This is only possible while no payments are recorded against it.",
    comment: "Reason",
    required: true,
    danger: true,
    what: "reverse the approval",
    done: "Approval reversed. The hours are unlocked.",
  },
};

export const HISTORY_LABEL: Record<string, string> = {
  calculated: "Calculated",
  submitted: "Sent for approval",
  approved: "Approved",
  rejected: "Sent back for changes",
  cancelled: "Cancelled",
  reversed: "Approval reversed",
};
export const PAYMENT_STATUS: Record<ItemPaymentStatus, { tone: Tone; label: string }> = {
  nothing_owed: { tone: "neutral", label: "Nothing owed" },
  paid: { tone: "good", label: "Paid" },
  partially_paid: { tone: "warn", label: "Partly paid" },
  failed: { tone: "danger", label: "Payment failed" },
  unpaid: { tone: "neutral", label: "Not paid yet" },
};
export const WARNING_LABEL: Record<string, string> = {
  missing_rate: "No pay rate for some days",
  negative_net: "Deductions are more than earnings",
};

export const AMOUNT_RE = /^\d{1,12}(\.\d{1,3})?$/;
export const isZero = (amount: string) => /^0*(\.0*)?$/.test(amount);
export const hours = (seconds: number) => `${fmtHoursDec(seconds)} h`;
