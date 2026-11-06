"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { Plus, Search } from "lucide-react";
import { EMPLOYEE_STATUS_LABEL, EMPLOYEE_STATUSES, EMPLOYMENT_TYPE_LABEL, EMPLOYMENT_TYPES, type EmploymentType } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
import { EmptyState } from "@/components/ui";
import { PageHeader, Skeleton } from "@/components/AppUi";
import { AccountBadge, EmployeeStatusBadge, Initials, Pagination } from "@/components/staff/ui";
import { fmtRate } from "@/components/staff/EmployeeForm";
import { useApi } from "@/lib/api";
import { fmtDay, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

// ---------------------------------------------------------------------------------------------
// Everyone on the team, as the Stitch design's screen 26 ("People") draws it: Add, the status as a
// row of choices, a search, then one row per person (initials, name and role, rate, status and
// account) beside a short "How staff join". The other filters and the sort sit under the search.
// ---------------------------------------------------------------------------------------------

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

const STATUS_OPTIONS: Array<[StatusFilter, string]> = [["", "Active and on leave"], ...EMPLOYEE_STATUSES.map((s): [StatusFilter, string] => [s, EMPLOYEE_STATUS_LABEL[s]]), ["all", "Everyone"]];
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
  const open = (e: EmployeeRow) => router.push(`/staff/employee?id=${encodeURIComponent(e.id)}`);

  return (
    <>
      <PageHeader
        title="All employees"
        sub={view ? `${new Intl.NumberFormat().format(view.total)} ${view.total === 1 ? "person" : "people"}${filtered ? " match these filters" : ""}` : "Everyone on your team, their status and whether they've set up their account."}
        actions={
          can("staff:manage") && (
            <Link href="/staff/employees/new" className="btn-primary h-10">
              <Plus aria-hidden className="h-4 w-4" />
              Add staff
            </Link>
          )
        }
      />

      <section className="home-card animate-rise space-y-4 p-4 sm:p-5" aria-label="Find employees">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Status" className="-mx-1 flex max-w-full gap-1 overflow-x-auto rounded bg-home-soft p-1 sm:mx-0">
            {STATUS_OPTIONS.map(([v, l]) => (
              <button
                key={v || "current"}
                type="button"
                aria-pressed={status === v}
                onClick={() => setStatus(v)}
                className={`rounded px-3 py-1.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent ${status === v ? "bg-surface font-medium text-text shadow-[var(--shadow)]" : "text-muted hover:text-text"}`}
              >
                {l}
                {status === v && view && <span className="ml-1.5 tabular-nums">{new Intl.NumberFormat().format(view.total)}</span>}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-72">
            <label className="sr-only" htmlFor={id("q")}>
              Search
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
            <input id={id("q")} type="search" className="input pl-9" value={q} maxLength={100} placeholder="Name, email, employee ID or job title" onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="label text-xs text-muted" htmlFor={id("dept")}>
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
            <label className="label text-xs text-muted" htmlFor={id("type")}>
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
            <label className="label text-xs text-muted" htmlFor={id("position")}>
              Position
            </label>
            <input id={id("position")} className="input" value={jobTitle} maxLength={80} placeholder="Exact job title, like Barista" onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs text-muted" htmlFor={id("account")}>
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
            <label className="label text-xs text-muted" htmlFor={id("sort")}>
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
          <button type="button" className="text-sm font-medium text-accent underline-offset-2 hover:underline" onClick={clear}>
            Clear filters
          </button>
        )}
      </section>

      {list.error && <LoadError what="the employee list" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />}
      {config.error && !list.error && <LoadError what="your departments" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
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
            <section className={`home-card animate-rise overflow-hidden transition-opacity ${list.loading ? "opacity-70" : ""}`} aria-label="Employees" aria-busy={list.loading}>
              <ul className="divide-y divide-home-line">
                {view.items.map((e) => (
                  <li key={e.id} className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-home-soft/60 sm:flex-nowrap sm:px-5" onClick={() => open(e)}>
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <Initials name={e.fullName} />
                      <span className="min-w-0">
                        <Link href={`/staff/employee?id=${encodeURIComponent(e.id)}`} className="font-medium hover:text-accent hover:underline" onClick={(ev) => ev.stopPropagation()}>
                          {e.fullName}
                        </Link>
                        <span className="block truncate text-sm text-muted">
                          {e.jobTitle}
                          {e.department ? ` · ${e.department.name}` : ""} · {EMPLOYMENT_TYPE_LABEL[e.employmentType]}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {e.employeeNumber} · <span className="break-all">{e.email}</span>
                        </span>
                      </span>
                    </span>
                    <span className="ml-13 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm sm:ml-0 sm:flex-nowrap sm:justify-end">
                      {showPay && (
                        <span className="tabular-nums whitespace-nowrap">
                          {"hourlyRate" in e && e.hourlyRate ? fmtRate(e.hourlyRate, e.currency) : <span className="text-muted">No hourly rate</span>}
                          <span className="sr-only"> hourly rate</span>
                        </span>
                      )}
                      <EmployeeStatusBadge status={e.status} />
                      <AccountBadge account={e.account} />
                      <span className="text-xs whitespace-nowrap text-muted">Joined {fmtDay(e.joinedOn, { weekday: false, year: true })}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-home-line px-4 pb-4 sm:px-5">
                <Pagination page={view.page} pageSize={view.pageSize} total={view.total} onPage={setPage} />
              </div>
            </section>
          ) : null}
        </div>

        <Card id="how-staff-join" title="How staff join" className="self-start">
          <p className="text-sm leading-relaxed text-muted">
            They get an invitation by email, or a link you send them yourself, and set a password. Then, in their phone&apos;s browser, they clock in, take breaks and see their
            shifts, hours and pay. They never see your sales.
          </p>
          <Link href="/staff/invitations" className="mt-3 text-sm font-medium text-accent hover:underline">
            Invitations
          </Link>
        </Card>
      </div>
    </>
  );
}
