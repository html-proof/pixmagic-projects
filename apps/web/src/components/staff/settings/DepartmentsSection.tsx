"use client";
/** Departments: groups of employees for filters, schedules and reports. */
import { useCallback, useId, useState, type FormEvent } from "react";
import { Panel } from "@/components/dashboard/Primitives";
import { ConfirmDialog, useAction } from "@/components/AppUi";
import { api } from "@/lib/api";
import { useStaff, type StaffConfig } from "@/lib/staff";
import { ReadOnlyNote } from "@/components/staff/settings/SettingsUi";

const enc = encodeURIComponent;

export function DepartmentsSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const uid = useId();
  const editable = can("staff:manage");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<StaffConfig["departments"][number] | null>(null);
  const closeRemove = useCallback(() => setRemoving(null), []);
  const taken = (n: string, except?: string) => config.departments.some((d) => d.id !== except && d.name.trim().toLowerCase() === n.trim().toLowerCase());

  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return setNameError("Enter a name for the department.");
    if (n.length > 80) return setNameError("Keep the name under 80 characters.");
    if (taken(n)) return setNameError("There's already a department with that name.");
    setNameError(null);
    void run("add", "add the department", async () => {
      await api(`${base}/departments`, { method: "POST", body: { name: n } });
      setName("");
      onChanged();
      return `${n} added.`;
    });
  };

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const n = renaming.name.trim();
    if (!n) return setRenameError("Enter a name for the department.");
    if (n.length > 80) return setRenameError("Keep the name under 80 characters.");
    if (taken(n, renaming.id)) return setRenameError("There's already a department with that name.");
    setRenameError(null);
    void run(`rename:${renaming.id}`, "rename the department", async () => {
      await api(`${base}/departments/${enc(renaming.id)}`, { method: "PATCH", body: { name: n } });
      setRenaming(null);
      onChanged();
      return "Department renamed.";
    });
  };

  const remove = () =>
    run("remove", "delete the department", async () => {
      if (!removing) return;
      await api(`${base}/departments/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} deleted.`;
    });

  return (
    <Panel id="staff-departments" title="Departments" help="Group employees for filters, schedules and reports.">
      {!editable && <ReadOnlyNote>Only owners, admins and HR managers can change departments.</ReadOnlyNote>}
      {config.departments.length === 0 ? (
        <p className="text-sm text-muted">No departments yet.{editable ? " Add one below, or type a new one when adding an employee." : ""}</p>
      ) : (
        <ul className="divide-y divide-border">
          {config.departments.map((dpt) => (
            <li key={dpt.id} className="py-2.5">
              {renaming?.id === dpt.id ? (
                <form onSubmit={rename} noValidate className="flex flex-wrap items-start gap-2">
                  <div className="min-w-48 flex-1">
                    <label htmlFor={`${uid}-rename`} className="sr-only">
                      New name for {dpt.name}
                    </label>
                    <input id={`${uid}-rename`} className="input" autoFocus maxLength={80} value={renaming.name} onChange={(e) => setRenaming({ id: dpt.id, name: e.target.value })} aria-invalid={!!renameError} />
                    {renameError && <p className="mt-1 text-xs text-danger">{renameError}</p>}
                  </div>
                  <button type="submit" className="btn-primary" disabled={busy !== null}>
                    {busy === `rename:${dpt.id}` ? "Saving…" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy !== null}
                    onClick={() => {
                      setRenaming(null);
                      setRenameError(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="min-w-0">
                    <span className="font-medium">{dpt.name}</span>
                    <span className="text-sm text-muted">
                      {" "}
                      · {dpt.employees} {dpt.employees === 1 ? "employee" : "employees"}
                    </span>
                  </p>
                  {editable && (
                    <div className="flex gap-3 text-sm">
                      <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => setRenaming({ id: dpt.id, name: dpt.name })} aria-label={`Rename ${dpt.name}`}>
                        Rename
                      </button>
                      <button type="button" className="text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(dpt)} aria-label={`Delete ${dpt.name}`}>
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={add} noValidate className="mt-4 flex flex-wrap items-start gap-2 border-t border-border pt-4">
          <div className="min-w-48 flex-1">
            <label htmlFor={`${uid}-new`} className="label">
              New department
            </label>
            <input id={`${uid}-new`} className="input" maxLength={80} value={name} placeholder="e.g. Kitchen" onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              aria-invalid={!!nameError}
            />
            {nameError && <p className="mt-1 text-xs text-danger">{nameError}</p>}
          </div>
          <button type="submit" className="btn-secondary sm:mt-6" disabled={busy !== null}>
            {busy === "add" ? "Adding…" : "Add department"}
          </button>
        </form>
      )}
      <ConfirmDialog open={!!removing} title={`Delete ${removing?.name ?? "this department"}?`} confirmLabel="Delete department" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        <p>
          {removing && removing.employees > 0
            ? `The ${removing.employees} ${removing.employees === 1 ? "employee" : "employees"} in it will be left without a department. Nothing else about them changes.`
            : "No employees are in it."}
        </p>
      </ConfirmDialog>
    </Panel>
  );
}
