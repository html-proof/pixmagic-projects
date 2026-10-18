"use client";
/** Public holidays: nobody is marked absent, and hours are paid at the holiday rate. */
import { useCallback, useId, useState, type FormEvent } from "react";
import { isCalendarDay, localDayOf } from "@app/shared/staff";
import { Panel } from "@/components/dashboard/Primitives";
import { ConfirmDialog, useAction } from "@/components/AppUi";
import { Field } from "@/components/staff/ui";
import { api } from "@/lib/api";
import { fmtDay, useStaff, type StaffConfig } from "@/lib/staff";
import { ReadOnlyNote } from "@/components/staff/settings/SettingsUi";

const enc = encodeURIComponent;

export function HolidaysSection({ config, onChanged }: { config: StaffConfig; onChanged: () => void }) {
  const { base, can } = useStaff();
  const { busy, run } = useAction();
  const uid = useId();
  const editable = can("staff:settings");
  const today = localDayOf(Date.now(), config.settings.timezone);
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<{ day?: string; name?: string }>({});
  const [removing, setRemoving] = useState<StaffConfig["holidays"][number] | null>(null);
  const closeRemove = useCallback(() => setRemoving(null), []);
  const upcoming = config.holidays.filter((h) => h.day >= today);
  const past = config.holidays.filter((h) => h.day < today).reverse();

  const add = (e: FormEvent) => {
    e.preventDefault();
    const found: typeof errors = {};
    if (!isCalendarDay(day)) found.day = "Choose the holiday's date.";
    else if (config.holidays.some((h) => h.day === day)) found.day = "That day is already a holiday.";
    if (!name.trim()) found.name = "Name the holiday, like New Year's Day.";
    else if (name.trim().length > 80) found.name = "Keep the name under 80 characters.";
    setErrors(found);
    if (Object.keys(found).length) return;
    void run("add", "add the holiday", async () => {
      await api(`${base}/holidays`, { method: "POST", body: { day, name: name.trim() } });
      setDay("");
      setName("");
      onChanged();
      return `${name.trim()} added.`;
    });
  };

  const remove = () =>
    run("remove", "remove the holiday", async () => {
      if (!removing) return;
      await api(`${base}/holidays/${enc(removing.id)}`, { method: "DELETE" });
      setRemoving(null);
      onChanged();
      return `${removing.name} removed.`;
    });

  const list = (items: StaffConfig["holidays"]) => (
    <ul className="divide-y divide-border">
      {items.map((h) => (
        <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
          <p className="min-w-0">
            <span className="font-medium">{h.name}</span>
            <span className="text-sm text-muted"> · {fmtDay(h.day)}</span>
          </p>
          {editable && (
            <button type="button" className="text-sm text-muted underline-offset-2 hover:text-danger hover:underline" onClick={() => setRemoving(h)} aria-label={`Remove ${h.name} on ${fmtDay(h.day)}`}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Panel id="staff-holidays" title="Public holidays" help="On these days nobody is marked absent, and hours are paid at the holiday rate of the employee's overtime policy (if it has one).">
      {!editable && <ReadOnlyNote>Only owners and admins can change public holidays.</ReadOnlyNote>}
      {config.holidays.length === 0 ? (
        <p className="text-sm text-muted">No public holidays added. Add the ones your business observes; bizinsights doesn&apos;t add any by itself.</p>
      ) : (
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold">Upcoming</h3>
            {upcoming.length ? list(upcoming) : <p className="py-2 text-sm text-muted">None coming up.</p>}
          </div>
          {past.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Past ({past.length})</summary>
              {list(past)}
            </details>
          )}
        </div>
      )}
      {editable && (
        <form onSubmit={add} noValidate className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
          <Field label="Date" htmlFor={`${uid}-day`} error={errors.day}>
            <input id={`${uid}-day`} type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} aria-invalid={!!errors.day} />
          </Field>
          <Field label="Holiday name" htmlFor={`${uid}-name`} error={errors.name}>
            <input id={`${uid}-name`} className="input" maxLength={80} value={name} placeholder="e.g. New Year's Day" onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name} />
          </Field>
          <button type="submit" className="btn-secondary sm:mt-6" disabled={busy !== null}>
            {busy === "add" ? "Adding…" : "Add holiday"}
          </button>
        </form>
      )}
      <ConfirmDialog open={!!removing} title={`Remove ${removing?.name ?? "this holiday"}?`} confirmLabel="Remove holiday" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={closeRemove}>
        <p>{removing ? `${fmtDay(removing.day)} becomes a normal working day for pay and attendance. Days in approved payroll can't be changed.` : ""}</p>
      </ConfirmDialog>
    </Panel>
  );
}
