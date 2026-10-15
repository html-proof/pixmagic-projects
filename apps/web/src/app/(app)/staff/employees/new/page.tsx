"use client";
import Link from "next/link";
import { useState } from "react";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { PageHeader, Skeleton, useAction } from "@/components/AppUi";
import { EmployeeForm, InvitationLinkPanel, inviteEmployee, type EmployeePayload, type SharedLink } from "@/components/staff/EmployeeForm";
import { api, useApi } from "@/lib/api";
import { fmtDateTime, useStaff, type EmployeeRow, type StaffConfig } from "@/lib/staff";

export default function NewEmployeePage() {
  const { base, can } = useStaff();
  const config = useApi<StaffConfig>(can("staff:manage") ? `${base}/config` : null);
  // The employee just added, kept with the workspace it was added to (a switch starts over).
  const [created, setCreated] = useState<{ base: string; employee: EmployeeRow } | null>(null);
  const [formKey, setFormKey] = useState(0);

  if (!can("staff:manage")) {
    return (
      <div className="card max-w-xl">
        <h1 className="text-lg font-semibold">Add employee</h1>
        <p className="mt-1 text-sm text-muted">Only owners, admins and HR managers can add employees. Ask one of them to add this person for you.</p>
      </div>
    );
  }

  const save = async (payload: EmployeePayload) => {
    const { employee } = await api<{ employee: EmployeeRow }>(`${base}/employees`, { method: "POST", body: payload });
    setCreated({ base, employee });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const addAnother = () => {
    setCreated(null);
    setFormKey((k) => k + 1);
    // A department typed on the last form now exists: offer it in the list.
    void config.reload();
  };

  if (created && created.base === base && config.data) {
    return <Added employee={created.employee} timeZone={config.data.settings.timezone} onAddAnother={addAnother} />;
  }

  return (
    <>
      <PageHeader title="Add employee" sub="Add their details now and invite them when you're ready. With their own account they clock in and out, take breaks and see their hours and pay." />
      {config.error ? (
        <LoadError what="the employee form" error={config.error} onRetry={() => void config.reload()} busy={config.loading} />
      ) : !config.data ? (
        <Skeleton lines={8} />
      ) : (
        <section className="card animate-rise">
          <EmployeeForm key={`${base}-${formKey}`} config={config.data} submitLabel="Save employee" onSubmit={save} />
        </section>
      )}
    </>
  );
}

function Added({ employee, timeZone, onAddAnother }: { employee: EmployeeRow; timeZone: string; onAddAnother: () => void }) {
  const { base } = useStaff();
  const { busy, run } = useAction();
  const [link, setLink] = useState<SharedLink | null>(null);
  const [emailed, setEmailed] = useState<{ expiresAt: string } | null>(null);
  const firstName = employee.fullName.split(/\s+/)[0] || employee.fullName;

  const invite = (delivery: "email" | "link") =>
    run(delivery, delivery === "email" ? "send the invitation" : "create the invitation link", async () => {
      const { result, link: shared } = await inviteEmployee(base, employee.id, delivery);
      setLink(shared);
      setEmailed(delivery === "email" && result.emailed ? { expiresAt: result.expiresAt } : null);
      if (delivery === "email") return result.emailed ? `Invitation sent to ${employee.email}.` : undefined;
      return shared?.why === "copied" ? "Invitation link copied." : undefined;
    });

  return (
    <>
      <PageHeader title="Employee added" sub={`${employee.fullName} is now on your team.`} />
      <section className="card animate-rise space-y-5" aria-labelledby="added-heading">
        <div className="flex flex-wrap items-center gap-4">
          <div className="rounded-xl border border-border bg-bg px-4 py-3">
            <p className="text-xs text-muted">Employee ID</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="new-employee-number">
              {employee.employeeNumber}
            </p>
          </div>
          <div className="min-w-0">
            <h2 id="added-heading" className="font-semibold">
              {employee.fullName}
            </h2>
            <p className="text-sm text-muted">
              {employee.jobTitle}
              {employee.department ? ` · ${employee.department.name}` : ""}
            </p>
            <p className="break-all text-sm text-muted">{employee.email}</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Invite {firstName} to set up their account</h3>
            <p className="mt-1 text-sm text-muted">
              Send the invitation by email, or copy a link to send yourself (for example by text message). Until they join, you can still record and correct their hours.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void invite("email")}>
              {busy === "email" ? "Sending…" : "Send invitation"}
            </button>
            <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => void invite("link")}>
              {busy === "link" ? "Creating link…" : "Copy invitation link"}
            </button>
          </div>
          {emailed && (
            <Alert kind="success">
              Invitation emailed to {employee.email}. The link in it works once and expires {fmtDateTime(emailed.expiresAt, timeZone)}.
            </Alert>
          )}
          {link && <InvitationLinkPanel key={link.url} link={link} name={firstName} timeZone={timeZone} onDismiss={() => setLink(null)} />}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Link href={`/staff/employee?id=${encodeURIComponent(employee.id)}`} className="btn-secondary">
            View employee
          </Link>
          <button type="button" className="btn-secondary" onClick={onAddAnother}>
            Add another
          </button>
        </div>
      </section>
    </>
  );
}
