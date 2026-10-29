"use client";
import { useId, useState } from "react";
import { Trash2 } from "lucide-react";
import { BUSINESS_EVENT_KINDS, BUSINESS_EVENT_KIND_LABEL, businessEventInput, type BusinessEvent, type BusinessEventKind } from "@app/shared/businessEvents";
import { ConfirmDialog, Dialog, useAction } from "@/components/AppUi";
import { api } from "@/lib/api";
import { EVENT_DOT } from "./sheetUi";

/** What the dialog opens on: a new event over some days, or one to change. */
export type EventDraft = { event: BusinessEvent } | { from: string; to: string };

/**
 * Adding, changing or removing a business event: its name, what kind of event it is, its first and
 * last day, and a note. The API checks the same rules (businessEventInput) and keeps who did it.
 */
export function EventDialog({
  draft,
  base,
  today,
  onClose,
  onSaved,
  onRemoved,
}: {
  draft: EventDraft | null;
  /** /workspaces/:ws/stores/:storeId */
  base: string;
  today: string;
  onClose: () => void;
  onSaved: (e: BusinessEvent) => void;
  onRemoved: (id: string) => void;
}) {
  return (
    <Dialog open={!!draft} title={draft && "event" in draft ? "Change business event" : "Add a business event"} onClose={onClose}>
      {draft && <EventForm key={"event" in draft ? draft.event.id : `${draft.from}:${draft.to}`} draft={draft} base={base} today={today} onClose={onClose} onSaved={onSaved} onRemoved={onRemoved} />}
    </Dialog>
  );
}

function EventForm({ draft, base, today, onClose, onSaved, onRemoved }: { draft: EventDraft; base: string; today: string; onClose: () => void; onSaved: (e: BusinessEvent) => void; onRemoved: (id: string) => void }) {
  const id = useId();
  const editing = "event" in draft ? draft.event : null;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [kind, setKind] = useState<BusinessEventKind>(editing?.kind ?? "sale");
  const [startsOn, setStartsOn] = useState(editing?.startsOn ?? ("from" in draft ? draft.from : today));
  const [endsOn, setEndsOn] = useState(editing?.endsOn ?? ("to" in draft ? draft.to : today));
  const [note, setNote] = useState(editing?.note ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, run } = useAction();

  const save = async () => {
    const parsed = businessEventInput.safeParse({ title, kind, startsOn, endsOn, note: note.trim() ? note : null });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Check the event's details.");
      return;
    }
    setProblem(null);
    await run("save", editing ? "change the event" : "add the event", async () => {
      const { event } = editing
        ? await api<{ event: BusinessEvent }>(`${base}/business-events/${encodeURIComponent(editing.id)}`, { method: "PUT", body: parsed.data })
        : await api<{ event: BusinessEvent }>(`${base}/business-events`, { method: "POST", body: parsed.data });
      onSaved(event);
      onClose();
      return editing ? "Event saved" : "Event added";
    });
  };

  const remove = async () => {
    if (!editing) return;
    await run("remove", "remove the event", async () => {
      await api(`${base}/business-events/${encodeURIComponent(editing.id)}`, { method: "DELETE" });
      setConfirming(false);
      onRemoved(editing.id);
      onClose();
      return "Event removed";
    });
  };

  // The confirmation sits beside the form, not in it: React carries its submit up to a form around it, portal or not.
  return (
    <>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void save();
        }}
        data-testid="event-form"
      >
        <p className="text-sm text-muted">Mark what happened in the business on these days, so the sheet can show those days apart and set them against the rest.</p>
        <div>
          <label className="label" htmlFor={`${id}-title`}>
            Name
          </label>
          <input id={`${id}-title`} className="input" maxLength={80} placeholder="Spring sale, new ad campaign, product launch…" value={title} onChange={(e) => setTitle(e.target.value)} data-testid="event-title" />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-kind`}>
            Kind of event
          </label>
          <div className="flex items-center gap-2">
            <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${EVENT_DOT[kind]}`} />
            <select id={`${id}-kind`} className="input" value={kind} onChange={(e) => setKind(e.target.value as BusinessEventKind)} data-testid="event-kind">
              {BUSINESS_EVENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {BUSINESS_EVENT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor={`${id}-from`}>
              First day
            </label>
            <input
              id={`${id}-from`}
              type="date"
              className="input"
              value={startsOn}
              onChange={(e) => {
                setStartsOn(e.target.value);
                if (endsOn && e.target.value > endsOn) setEndsOn(e.target.value);
              }}
              data-testid="event-from"
            />
          </div>
          <div>
            <label className="label" htmlFor={`${id}-to`}>
              Last day
            </label>
            <input id={`${id}-to`} type="date" className="input" min={startsOn || undefined} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} data-testid="event-to" />
          </div>
        </div>
        <div>
          <label className="label" htmlFor={`${id}-note`}>
            Note <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea id={`${id}-note`} className="input min-h-20" maxLength={500} placeholder="20% off everything, code SPRING20" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        {problem && (
          <p className="text-sm text-warn" role="alert">
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {editing ? (
            <button type="button" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-danger hover:bg-danger/10" onClick={() => setConfirming(true)} disabled={!!busy} data-testid="event-remove">
              <Trash2 aria-hidden className="h-4 w-4" />
              Remove
            </button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!!busy} data-testid="event-save">
              {busy === "save" ? "Saving…" : editing ? "Save" : "Add event"}
            </button>
          </span>
        </div>
      </form>
      <ConfirmDialog open={confirming} title="Remove this event?" confirmLabel="Remove" danger busy={busy === "remove"} onConfirm={() => void remove()} onCancel={() => setConfirming(false)}>
        <p>&ldquo;{editing?.title}&rdquo; comes off the sheet for everyone in the business. The figures of its days don&apos;t change.</p>
      </ConfirmDialog>
    </>
  );
}
