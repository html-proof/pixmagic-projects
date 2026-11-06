"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CUSTOM_EVENT_EXAMPLES } from "@app/shared/email";
import { checkEmailMessage, emailEventFor, emailVariablesFor, type HubTrigger, type MessageCategory } from "@app/shared/automations";
import { AUTOMATION_STARTERS, automationVariables, checkAutomationMessage, ORDER_STATUS_WORD, previewSms, smsSegments, SMS_VARIABLE_INFO, TRIGGER_INFO, type SmsTrigger } from "@app/shared/sms";
import { EmailPreviewFrame } from "@/components/email/EmailUi";
import { PhonePreview, type PreviewSender } from "@/components/messaging/PhonePreview";
import { consentWords } from "@/components/messaging/AutomationUi";
import { api, useApi } from "@/lib/api";
import { useHub } from "./HubUi";

// ---------------------------------------------------------------------------
// Step 3: the message, for each channel. Every check is the shared rule the API applies too
// (@app/shared/sms, @app/shared/automations), so what the page says is what saving will say. The
// previews use sample data: never a real customer.
// ---------------------------------------------------------------------------

export interface SmsDraft {
  name: string;
  body: string;
  delayMinutes: number;
  discountCode: string;
  dryRun: boolean;
  inactiveDays: number | null;
  vipMinOrders: number | null;
  vipMinSpent: number | null;
  /** The rest of a saved automation's settings (quiet hours, caps, conditions), kept as they were. */
  rest: Record<string, unknown>;
}

export interface EmailDraft {
  name: string;
  senderIdentityId: string;
  subject: string;
  text: string;
  delayMinutes: number;
  customEvent: string;
  category: MessageCategory;
  /** At most one email per customer in this many hours (0: once per event). */
  onceEveryHours: number;
}

const DELAYS: Array<[number, string]> = [
  [0, "Right away"],
  [15, "After 15 minutes"],
  [60, "After 1 hour"],
  [180, "After 3 hours"],
  [1440, "After 1 day"],
  [4320, "After 3 days"],
];

function DelayPicker({ id, value, onChange }: { id: string; value: number; onChange: (n: number) => void }) {
  const known = DELAYS.some(([n]) => n === value);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {!known && <option value={value}>After {value} minutes</option>}
      {DELAYS.map(([n, l]) => (
        <option key={n} value={n}>
          {l}
        </option>
      ))}
    </select>
  );
}

/** Insert `{{token}}` where the cursor is in a textarea (or at the end). */
function useInserter(value: string, onChange: (v: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (token: string) => {
    const el = ref.current;
    const at = el ? el.selectionStart : value.length;
    const end = el ? el.selectionEnd : value.length;
    const next = `${value.slice(0, at)}{{${token}}}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = at + token.length + 4;
      el?.setSelectionRange(pos, pos);
    });
  };
  return { ref, insert };
}

function Issues({ issues }: { issues: Array<{ level: string; message: string }> }) {
  if (!issues.length) return <p className="text-xs text-good">No problems found.</p>;
  return (
    <ul className="space-y-1 text-xs" aria-label="Problems with the message">
      {issues.map((i) => (
        <li key={i.message} className={i.level === "error" ? "text-danger" : "text-warn"}>
          {i.level === "error" ? "Fix: " : "Note: "}
          {i.message}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

export function smsIssues(d: SmsDraft, trigger: SmsTrigger) {
  return checkAutomationMessage(d.body, trigger, d.discountCode || null);
}

export function SmsEditor({ trigger, draft, onChange, sender, business }: { trigger: SmsTrigger; draft: SmsDraft; onChange: (d: SmsDraft) => void; sender: PreviewSender; business: string }) {
  const set = (p: Partial<SmsDraft>) => onChange({ ...draft, ...p });
  const { ref, insert } = useInserter(draft.body, (body) => set({ body }));
  const issues = smsIssues(draft, trigger);
  const text = previewSms(draft.body, {
    customer_name: "Sarah",
    order_number: "#1042",
    order_total: "89.95",
    product_name: "Linen Shirt",
    business_name: business,
    store_name: business,
    order_status: ORDER_STATUS_WORD[trigger] ?? "confirmed",
    ...(draft.discountCode ? { discount_code: draft.discountCode } : {}),
  });
  const marketing = TRIGGER_INFO[trigger].category === "marketing";
  const usesCode = /\{\{\s*discount_code\s*\}\}/.test(draft.body);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="sms-name">
            Automation name
          </label>
          <input id="sms-name" className="input" maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        {AUTOMATION_STARTERS[trigger].length > 0 && (
          <div>
            <p className="label">Ready-made messages</p>
            <div className="flex flex-wrap gap-2">
              {AUTOMATION_STARTERS[trigger].map((s) => (
                <button key={s.name} type="button" className="home-btn h-8 text-xs" onClick={() => set({ body: s.body, name: draft.name || s.name })}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="label" htmlFor="sms-body">
            Message
          </label>
          <textarea id="sms-body" ref={ref} className="input min-h-32" maxLength={1600} value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Insert a detail">
            {automationVariables(trigger).map((v) => (
              <button key={v} type="button" className="rounded bg-home-tag px-2.5 py-1 text-xs font-medium text-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent" onClick={() => insert(v)}>
                + {SMS_VARIABLE_INFO[v].label}
              </button>
            ))}
          </div>
        </div>
        {usesCode && (
          <div>
            <label className="label" htmlFor="sms-code">
              Discount code (create it in Shopify first)
            </label>
            <input id="sms-code" className="input" maxLength={30} value={draft.discountCode} onChange={(e) => set({ discountCode: e.target.value })} />
          </div>
        )}
        {trigger === "customer_inactive" && (
          <div>
            <label className="label" htmlFor="sms-inactive">
              Days without an order before a customer counts as inactive
            </label>
            <input id="sms-inactive" className="input" type="number" min={14} max={1095} value={draft.inactiveDays ?? ""} onChange={(e) => set({ inactiveDays: e.target.value ? Number(e.target.value) : null })} />
          </div>
        )}
        {trigger === "customer_vip" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="sms-vip-orders">
                Orders that make a VIP
              </label>
              <input id="sms-vip-orders" className="input" type="number" min={2} value={draft.vipMinOrders ?? ""} onChange={(e) => set({ vipMinOrders: e.target.value ? Number(e.target.value) : null })} />
            </div>
            <div>
              <label className="label" htmlFor="sms-vip-spent">
                Or spend that makes a VIP
              </label>
              <input id="sms-vip-spent" className="input" type="number" min={1} value={draft.vipMinSpent ?? ""} onChange={(e) => set({ vipMinSpent: e.target.value ? Number(e.target.value) : null })} />
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="sms-delay">
              When to send
            </label>
            <DelayPicker id="sms-delay" value={draft.delayMinutes} onChange={(delayMinutes) => set({ delayMinutes })} />
          </div>
          <label className="flex items-start gap-2 self-end pb-2 text-sm">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={draft.dryRun} onChange={(e) => set({ dryRun: e.target.checked })} />
            <span>
              Test mode
              <span className="block text-xs text-muted">Record what it would send in the history, and send nothing.</span>
            </span>
          </label>
        </div>
        <div className="rounded bg-home-soft px-3 py-2.5 text-xs text-muted">
          <p className="font-medium text-text">Who gets it</p>
          <p>{consentWords(trigger)}</p>
          {marketing && <p className="mt-1">A marketing text must carry the opt-out link; quiet hours and frequency caps apply.</p>}
        </div>
        <Issues issues={issues} />
      </div>
      <PhonePreview sender={sender} text={text} segments={smsSegments(text)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function emailIssues(d: EmailDraft, trigger: HubTrigger) {
  return checkEmailMessage({ subject: d.subject, text: d.text }, emailEventFor(trigger, d.customEvent || null), d.category);
}

interface SenderView {
  id: string;
  email: string;
  name: string | null;
  status: string;
  isDefault: boolean;
}

export function EmailEditor({ trigger, draft, onChange }: { trigger: HubTrigger; draft: EmailDraft; onChange: (d: EmailDraft) => void }) {
  const { path, ws } = useHub();
  const set = (p: Partial<EmailDraft>) => onChange({ ...draft, ...p });
  const senders = useApi<{ senders: SenderView[] }>(`/workspaces/${ws}/email/senders`);
  const verified = (senders.data?.senders ?? []).filter((s) => s.status === "verified");
  const { ref, insert } = useInserter(draft.text, (text) => set({ text }));
  const custom = trigger === "external_event";
  const variables = useMemo(() => emailVariablesFor(trigger, draft.category, draft.customEvent || null), [trigger, draft.category, draft.customEvent]);
  const issues = emailIssues(draft, trigger);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const previewUrl = path("/preview/email");

  // A sender picked for them when there's only one (or a default).
  useEffect(() => {
    if (!draft.senderIdentityId && verified.length) onChange({ ...draft, senderIdentityId: (verified.find((s) => s.isDefault) ?? verified[0]!).id });
  }, [verified.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server renders the preview (the business's name and address, the marketing footer), a moment after typing stops.
  const errorFree = !issues.some((i) => i.level === "error");
  useEffect(() => {
    if (!errorFree || (custom && !draft.customEvent)) return;
    let live = true;
    const t = window.setTimeout(() => {
      api<{ preview: { subject: string; html: string } | null }>(previewUrl, { method: "POST", body: { trigger, customEvent: draft.customEvent || null, category: draft.category, subject: draft.subject, text: draft.text } })
        .then((r) => live && setPreview(r.preview))
        .catch(() => live && setPreview(null));
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [draft.subject, draft.text, draft.category, draft.customEvent, trigger, errorFree, custom, previewUrl]);

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_24rem]">
      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="email-name">
            Automation name
          </label>
          <input id="email-name" className="input" maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        {custom && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="email-event">
                Your event&apos;s name
              </label>
              <input id="email-event" className="input" list="email-event-examples" placeholder="appointment.booked" value={draft.customEvent} onChange={(e) => set({ customEvent: e.target.value.trim().toLowerCase() })} />
              <datalist id="email-event-examples">
                {CUSTOM_EVENT_EXAMPLES.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
              <p className="mt-1 text-xs text-muted">Your system sends it to POST /api/v1/events with an event API key (Settings → Email → Settings).</p>
            </div>
            <div>
              <label className="label" htmlFor="email-category">
                Kind of email
              </label>
              <select id="email-category" className="input" value={draft.category} onChange={(e) => set({ category: e.target.value as MessageCategory })}>
                <option value="transactional">An update about something the customer did</option>
                <option value="marketing">Marketing (needs their consent)</option>
              </select>
            </div>
          </div>
        )}
        <div>
          <label className="label" htmlFor="email-sender">
            From
          </label>
          {senders.data && !verified.length ? (
            <p className="text-sm text-warn">No verified sender address yet: connect a mailbox and verify its address first.</p>
          ) : (
            <select id="email-sender" className="input" value={draft.senderIdentityId} onChange={(e) => set({ senderIdentityId: e.target.value })}>
              {verified.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name ? `${s.name} <${s.email}>` : s.email}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="label" htmlFor="email-subject">
            Subject
          </label>
          <input id="email-subject" className="input" maxLength={250} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="email-text">
            Message
          </label>
          <textarea id="email-text" ref={ref} className="input min-h-40" maxLength={20000} value={draft.text} onChange={(e) => set({ text: e.target.value })} />
          <p className="mt-1 text-xs text-muted">A blank line starts a new paragraph.</p>
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Insert a detail">
            {variables.map((v) => (
              <button key={v.path} type="button" className="rounded bg-home-tag px-2.5 py-1 text-xs font-medium text-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent" onClick={() => insert(v.path)}>
                + {v.label}
              </button>
            ))}
            {custom && (
              <button type="button" className="rounded border border-dashed border-home-tag px-2.5 py-1 text-xs font-medium text-muted outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent" onClick={() => insert("data.reference")}>
                + A field of your event (data.…)
              </button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="email-delay">
              When to send
            </label>
            <DelayPicker id="email-delay" value={draft.delayMinutes} onChange={(delayMinutes) => set({ delayMinutes })} />
          </div>
          <div>
            <label className="label" htmlFor="email-often">
              How often per customer
            </label>
            <select id="email-often" className="input" value={draft.onceEveryHours} onChange={(e) => set({ onceEveryHours: Number(e.target.value) })}>
              <option value={0}>Once for each event</option>
              <option value={24}>At most once a day</option>
              <option value={168}>At most once a week</option>
              <option value={720}>At most once in 30 days</option>
            </select>
          </div>
        </div>
        <div className="rounded bg-home-soft px-3 py-2.5 text-xs text-muted">
          <p className="font-medium text-text">Who gets it</p>
          {draft.category === "marketing" ? (
            <p>Only customers who agreed to email marketing. Every email carries an unsubscribe link and your postal address, and unsubscribed addresses are skipped.</p>
          ) : (
            <p>The customer the event is about, at the address on it. Addresses on your suppression list are skipped.</p>
          )}
        </div>
        <Issues issues={issues} />
      </div>
      <div className="space-y-2">
        <p className="label">Preview with sample data</p>
        {preview ? (
          <>
            <p className="rounded bg-home-soft px-3 py-2 text-sm">
              <span className="text-muted">Subject: </span>
              {preview.subject}
            </p>
            <EmailPreviewFrame html={preview.html} height={360} />
          </>
        ) : (
          <p className="rounded border border-dashed border-home-tag px-3 py-8 text-center text-sm text-muted">{errorFree ? "The preview appears here." : "Fix the problems to see the preview."}</p>
        )}
      </div>
    </div>
  );
}
