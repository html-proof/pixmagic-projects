"use client";
import { CalendarClock, Cake, CircleX, CreditCard, Crown, Moon, PackageCheck, ShoppingBag, ShoppingCart, Truck, Undo2, UserPlus, Users, Webhook, type LucideIcon } from "lucide-react";
import { AUTOMATION_TRIGGER_CARDS, automationTriggerCard, ORDER_STATUS_WORD, previewSms, RULE_CONDITION_LABEL, TRIGGER_INFO, type AutomationIcon, type RuleCondition, type SmsAutomationInput, type SmsTrigger } from "@app/shared/sms";
import { ConfirmDialog } from "@/components/AppUi";
import type { Tone } from "@/components/dashboard/Primitives";
import { fmtDelay, fmtHour } from "./MessagingUi";
import { OP_LABEL } from "./RuleEditor";
import type { AutomationView, SendingProblem, SmsMode } from "./types";

// ---------------------------------------------------------------------------
// What the Automations list and the four-step builder share: the trigger icons, the timing in
// words, the sample customer in previews, and the dialog that asks before an automation goes live.
// ---------------------------------------------------------------------------

export const TRIGGER_ICON: Record<AutomationIcon, LucideIcon> = {
  "shopping-bag": ShoppingBag,
  "credit-card": CreditCard,
  truck: Truck,
  "package-check": PackageCheck,
  "shopping-cart": ShoppingCart,
  "user-plus": UserPlus,
  webhook: Webhook,
  "circle-x": CircleX,
  undo: Undo2,
  moon: Moon,
  crown: Crown,
  cake: Cake,
  users: Users,
  "calendar-clock": CalendarClock,
};

/** A trigger's icon (or, for a card with no trigger behind it, that card's). */
export function TriggerIcon({ trigger, card, className = "h-5 w-5" }: { trigger: SmsTrigger | null; card?: string; className?: string }) {
  const icon = trigger ? automationTriggerCard(trigger).icon : AUTOMATION_TRIGGER_CARDS.find((c) => c.key === card)?.icon;
  const Icon = icon ? TRIGGER_ICON[icon] : Webhook;
  return <Icon aria-hidden className={className} strokeWidth={1.8} />;
}

/** The sample customer every preview shows (Sarah's order #1042), with the business's own name. */
export const previewText = (body: string, trigger: SmsTrigger, business: string) =>
  previewSms(body, { customer_name: "Sarah", order_number: "#1042", order_total: "89.95", product_name: "Linen Shirt", business_name: business, store_name: business, order_status: ORDER_STATUS_WORD[trigger] ?? "confirmed" });

/** An automation's status as the list and the builder show it: the rule's own status, never the page's guess. */
export const AUTOMATION_STATUS: Record<AutomationView["status"], { tone: Tone; label: string }> = {
  active: { tone: "good", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
  draft: { tone: "neutral", label: "Draft" },
  pending_approval: { tone: "warn", label: "Waiting for approval" },
  disabled: { tone: "neutral", label: "Disabled" },
};

function conditionWords(c: RuleCondition): string {
  const value = Array.isArray(c.value) ? c.value.join(", ") : String(c.value);
  return `${RULE_CONDITION_LABEL[c.field].toLowerCase()} ${OP_LABEL[c.op] ?? c.op} ${value}`;
}

/** When it sends, in a sentence: "Right away", "2 hours after the order is placed, only if order total is at least 50". */
export function timingWords(a: Pick<SmsAutomationInput, "trigger" | "delayMinutes" | "conditions">): string {
  const when = a.delayMinutes ? `${fmtDelay(a.delayMinutes)} after the event` : "Right away";
  return a.conditions.length ? `${when}, only if ${a.conditions.map(conditionWords).join(" and ")}` : when;
}

/** Quiet hours in a sentence, with the time zone they're kept in. */
export function quietWords(a: Pick<SmsAutomationInput, "quietStart" | "quietEnd" | "useCustomerTimezone">, storeZone?: string): string {
  if (a.quietStart === a.quietEnd) return "No quiet hours";
  const store = storeZone ? `your store's time zone (${storeZone})` : "your store's time zone";
  const zone = a.useCustomerTimezone ? `the customer's local time where their country has one time zone, otherwise ${store}` : store;
  return `Never between ${fmtHour(a.quietStart)} and ${fmtHour(a.quietEnd)}, in ${zone}`;
}

/** Who may get it: the consent rule its category follows. */
export const consentWords = (trigger: SmsTrigger) =>
  TRIGGER_INFO[trigger].category === "marketing"
    ? "Only customers subscribed to your SMS marketing in Shopify who haven't opted out. Every text carries the opt-out link."
    : "Customers with a mobile number on the order, on the basis you chose for order updates. Anyone who opted out of all texts is skipped.";

/** The store-wide problems that stop this automation's texts (all texts, or its category's). */
export const problemsFor = (problems: SendingProblem[], category: AutomationView["category"]) => problems.filter((p) => p.stops === "all" || p.stops === category);

/** Asked before an automation is turned on (or its changes put live): what it sends, to whom, and what still stops it. */
export function ActivateDialog({
  open,
  name,
  trigger,
  body,
  business,
  mode,
  problems,
  republish,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  name: string;
  trigger: SmsTrigger | null;
  body: string | null;
  business: string;
  mode: SmsMode;
  problems: SendingProblem[];
  republish: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const blocking = trigger ? problemsFor(problems, TRIGGER_INFO[trigger].category).filter((p) => p.code !== "test_mode" && p.code !== "platform_off") : [];
  return (
    <ConfirmDialog open={open} title={republish ? `Put your changes to "${name}" live?` : `Activate "${name}"?`} confirmLabel={republish ? "Put changes live" : "Activate"} busy={busy} onConfirm={onConfirm} onCancel={onCancel}>
      {trigger && (
        <p>
          <strong className="text-text">{automationTriggerCard(trigger).label}.</strong> {automationTriggerCard(trigger).description} From now on, the customer gets:
        </p>
      )}
      {body && trigger && <div className="whitespace-pre-wrap rounded-xl border border-border bg-bg px-3 py-2 text-text">{previewText(body, trigger, business)}</div>}
      <p>It goes to real customers who may receive it, and activating it approves this message in your name.</p>
      {mode !== "live" && <p className="text-warn">Your SMS account is still being verified, so no customer is texted yet: what would be sent is recorded in Message History.</p>}
      {blocking.length > 0 && (
        <div>
          <p className="font-medium text-text">Texts won&apos;t reach customers until:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {blocking.map((p) => (
              <li key={p.code}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
    </ConfirmDialog>
  );
}
