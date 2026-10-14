"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPES, type EmploymentType } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/whatsapp/common";
import { AccountBadge, EmployeeStatusBadge, Pagination, Table, Td, Th } from "@/components/staff/ui";
import { fmtRate } from "@/components/staff/EmployeeForm";
import { useApi } from "@/lib/api";
import { fmtDay, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

interface EmployeeList {
  items: EmployeeRow[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 25;

type StatusFilter = "" | "active" | "on_leave" | "inactive" | "all";
type AccountFilter = "" | "active" | "invited" | "not_invited";
type Sort = "name" | "number" | "joined";

const STATUS_OPTIONS: Array<[StatusFilter, string]> = [
  ["", "Active and on leave"],
  ["active", "Active"],
  ["on_leave", "On leave"],
  ["inactive", "Deactivated"],
  ["all", "Everyone"],
];
const ACCOUNT_OPTIONS: Array<[AccountFilter, string]> = [
  ["", "Any account status"],
  ["active", "Account active"],
  ["invited", "Invited, not joined yet"],
  ["not_invited", "Not invited"],
];
const SORT_OPTIONS: Array<[Sort, string]> = [
  ["name", "Name (A–Z)"],
  ["number", "Employee ID"],
  ["joined", "Joining date (newest first)"],
];

/** `value`, once it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function EmployeesPage() {
  const { base, can } = useStaff();
  const router = useRouter();
  const uid = useId();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [departmentId, setDepartmentId] = useState("");
  const [employmentType, setEmploymentType] = useState<"" | EmploymentType>("");
  const [jobTitle, setJobTitle] = useState("");
  const [account, setAccount] = useState<AccountFilter>("");
  const [sort, setSort] = useState<Sort>("name");
  const search = useDebounced(q.trim());
  const position = useDebounced(jobTitle.trim());

  // The page belongs to the filters it was chosen under: any change of filter starts at page 1.
  const filterKey = JSON.stringify([base, search, status, departmentId, employmentType, position, account, sort]);
  const [paging, setPaging] = useState({ key: filterKey, page: 1 });
  const page = paging.key === filterKey ? paging.page : 1;
  const setPage = (p: number) => setPaging({ key: filterKey, page: p });

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort });
  if (search) params.set("q", search);
  if (status) params.set("status", status);
  if (departmentId) params.set("departmentId", departmentId);
  if (employmentType) params.set("employmentType", employmentType);
  if (position) params.set("jobTitle", position);
  if (account) params.set("account", account);
  const list = useApi<EmployeeList>(`${base}/employees?${params.toString()}`);
  const config = useApi<StaffConfig>(`${base}/config`);

  // Keep the last answer on screen while the next filter's answer loads, instead of flashing.
  const [shown, setShown] = useState<{ base: string; value: EmployeeList } | null>(null);
  useEffect(() => {
    if (list.data) setShown({ base, value: list.data });
  }, [list.data, base]);
  const view = list.data ?? (shown?.base === base ? shown.value : null);

  const filtered = !!(search || status || departmentId || employmentType || position || account);
  const clear = () => {
    setQ("");
    setStatus("");
    setDepartmentId("");
    setEmploymentType("");
    setJobTitle("");
    setAccount("");
  };
  const showPay = can("pay:view");
  const id = (k: string) => `${uid}-${k}`;

  return (
    <>
      <PageHeader
        title="All employees"
        sub={view ? `${new Intl.NumberFormat().format(view.total)} ${view.total === 1 ? "person" : "people"}${filtered ? " match these filters" : ""}` : "Everyone on your team, their status and whether they've set up their account."}
        actions={
          can("staff:manage") && (
            <Link href="/staff/employees/new" className="btn-primary">
              Add staff
            </Link>
          )
        }
      />

      <section className="card space-y-4" aria-label="Find employees">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="label" htmlFor={id("q")}>
              Search
            </label>
            <input id={id("q")} type="search" className="input" value={q} maxLength={100} placeholder="Name, email, employee ID or job title" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={id("status")}>
              Status
            </label>
            <select id={id("status")} className="input" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              {STATUS_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={id("dept")}>
              Department
            </label>
            <select id={id("dept")} className="input" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">All departments</option>
              {config.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={id("type")}>
              Employment type
            </label>
            <select id={id("type")} className="input" value={employmentType} onChange={(e) => setEmploymentType(e.target.value as "" | EmploymentType)}>
              <option value="">All types</option>
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {EMPLOYMENT_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={id("position")}>
              Position
            </label>
            <input id={id("position")} className="input" value={jobTitle} maxLength={80} placeholder="Exact job title, like Barista" onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor={id("account")}>
              Account
            </label>
            <select id={id("account")} className="input" value={account} onChange={(e) => setAccount(e.target.value as AccountFilter)}>
              {ACCOUNT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={id("sort")}>
              Sort by
            </label>
            <select id={id("sort")} className="input" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              {SORT_OPTIONS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
        {filtered && (
          <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={clear}>
            Clear filters
          </button>
        )}
      </section>

      {list.error && <LoadError what="the employee list" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />}
      {config.error && !list.error && <LoadError what="your departments" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />}

      {!view && !list.error ? (
        <Skeleton lines={6} />
      ) : view && view.total === 0 ? (
        filtered ? (
          <EmptyState
            title="No one matches these filters"
            body="Try a different search, or clear the filters to see everyone."
            action={
              <button type="button" className="btn-secondary" onClick={clear}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            title="No employees yet"
            body={can("staff:manage") ? "Add your first employee, then invite them so they can clock in and out and see their hours from their phone." : "Employees appear here once an owner, admin or HR manager adds them."}
            action={
              can("staff:manage") && (
                <Link href="/staff/employees/new" className="btn-primary">
                  Add staff
                </Link>
              )
            }
          />
        )
      ) : view ? (
        <section className={`card transition-opacity ${list.loading ? "opacity-70" : ""}`} aria-busy={list.loading}>
          <Table label="Employees">
            <thead>
              <tr>
                <Th>Employee</Th>
                <Th>Position</Th>
                <Th>Department</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Account</Th>
                {showPay && <Th right>Hourly rate</Th>}
                <Th>Joined</Th>
              </tr>
            </thead>
            <tbody>
              {view.items.map((e) => (
                <tr key={e.id} className="cursor-pointer transition hover:bg-bg/60" onClick={() => router.push(`/staff/employee?id=${encodeURIComponent(e.id)}`)}>
                  <Td>
                    <Link href={`/staff/employee?id=${encodeURIComponent(e.id)}`} className="font-medium hover:text-accent hover:underline" onClick={(ev) => ev.stopPropagation()}>
                      {e.fullName}
                    </Link>
                    <p className="text-xs text-muted">
                      {e.employeeNumber} · <span className="break-all">{e.email}</span>
                    </p>
                  </Td>
                  <Td>{e.jobTitle}</Td>
                  <Td>{e.department?.name ?? <span className="text-muted">—</span>}</Td>
                  <Td>{EMPLOYMENT_TYPE_LABEL[e.employmentType]}</Td>
                  <Td>
                    <EmployeeStatusBadge status={e.status} />
                  </Td>
                  <Td>
                    <AccountBadge account={e.account} />
                  </Td>
                  {showPay && <Td right>{"hourlyRate" in e && e.hourlyRate ? fmtRate(e.hourlyRate, e.currency) : <span className="text-muted">Not set</span>}</Td>}
                  <Td className="whitespace-nowrap">{fmtDay(e.joinedOn, { weekday: false, year: true })}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={view.page} pageSize={view.pageSize} total={view.total} onPage={setPage} />
        </section>
      ) : null}
    </>
  );
}
