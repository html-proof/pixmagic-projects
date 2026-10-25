/**
 * Whether a store can text its customers, in the merchant's words, and what an automation's review
 * checks before it is switched on. Built on sendingProblems (the answer every page gives) and the
 * SMS provider's own account check, cached for a few minutes. Nothing here names the provider: a
 * missing step reads as "Your SMS sender still needs to be verified", with where to fix it, and the
 * provider's own answers are logged, never shown.
 *
 *  - messagingReadiness: the overview's status (ready, setup required, action required) and its
 *    short list (sender, verification, permissions, monthly limit, automatic SMS, account, test
 *    recipient), each with its fix;
 *  - validateAutomation: the review step's checks for one automation, which say which of them stop
 *    it being switched on (activateAutomation refuses the same ones).
 */
import { systemDb, type Store } from "@app/db";
import { checkAutomationMessage, TRIGGER_INFO, type SmsCategory } from "@app/shared/sms";
import { logger } from "../logger.js";
import { audienceProblem, automationOf, sendingProblems, setupBlockers, triggerCapabilities, type SendingProblem } from "./builder.js";
import { monthSpend, senderOf, smsMode, smsRegion, type SmsDeps } from "./common.js";

// ---------------------------------------------------------------------------
// The SMS provider's account: production access or still in its test tier
// ---------------------------------------------------------------------------

export interface AccountStatus {
  /** The provider answered. */
  reachable: boolean;
  /** Still in the provider's test tier: texts reach only verified numbers. */
  sandbox: boolean;
}

const ACCOUNT_TTL_S = 600;
/** Where the last answer is kept (a production grant shows within 10 minutes). */
export const accountStatusKey = (region: string) => `sms:account:${region}`;

/** The provider's account check, asked at most every 10 minutes per region (it is the platform's account, the same for every store). */
export async function accountStatus(region: string, deps: Pick<SmsDeps, "coord" | "sms">): Promise<AccountStatus> {
  if (smsMode() === "off") return { reachable: false, sandbox: true };
  const key = accountStatusKey(region);
  const cached = await deps.coord.peek(key);
  if (cached) {
    try {
      return JSON.parse(cached) as AccountStatus;
    } catch {
      // Re-asked below.
    }
  }
  let status: AccountStatus;
  try {
    const a = await deps.sms.account(region);
    status = { reachable: true, sandbox: a.sandbox };
  } catch (err) {
    logger.warn({ err, region }, "sms account check failed");
    status = { reachable: false, sandbox: true };
  }
  // A failed check is asked again sooner.
  await deps.coord.put(key, JSON.stringify(status), status.reachable ? ACCOUNT_TTL_S : 60);
  return status;
}

// ---------------------------------------------------------------------------
// The overview's readiness
// ---------------------------------------------------------------------------

export type ReadinessStatus = "ready" | "setup_required" | "action_required";
export type ReadinessKey = "sender" | "verification" | "permissions" | "limit" | "sending" | "account" | "test_recipient";

export interface ReadinessItem {
  key: ReadinessKey;
  label: string;
  ok: boolean;
  /** What it is now ("Verified", "US$50 a month · US$12.40 used"). */
  detail: string;
  fix: { label: string; href: string } | null;
  /** Good to have, not needed to send (a test recipient). */
  optional: boolean;
  /** Not the store's to do: bizinsights and the SMS provider are finishing it (the account's verification). */
  waiting: boolean;
}

export interface MessagingReadiness {
  status: ReadinessStatus;
  /** Every text the store's automations send can reach a customer now. */
  ready: boolean;
  /** The platform or the provider account is still in test mode: texts are recorded, or reach test recipients only. */
  testMode: boolean;
  sender: boolean;
  verification: boolean;
  budget: boolean;
  consent: boolean;
  sending: boolean;
  testNumber: boolean;
  items: ReadinessItem[];
  /** What needs a look now that isn't one of the items (a hold, this month's limit used up, marketing off). */
  problems: SendingProblem[];
}

const SETUP = "/messaging/setup";
const BASIS_WORDS: Record<string, string> = {
  checkout_notice: "Your checkout tells customers order updates come by text",
  sms_consent: "Only customers who agreed to texts at checkout",
};

/** The store's messaging, as the overview shows it: one status and only what's missing. */
export async function messagingReadiness(store: Pick<Store, "id" | "workspaceId">, deps: Pick<SmsDeps, "coord" | "sms">): Promise<MessagingReadiness> {
  const [sender, problems, testNumbers, spend] = await Promise.all([
    senderOf(store.id),
    sendingProblems(store),
    systemDb.smsTestNumber.count({ where: { storeId: store.id, status: "verified" } }),
    monthSpend(store.id),
  ]);
  const account = await accountStatus(smsRegion(sender), deps);
  const has = (code: string) => problems.some((p) => p.code === code);
  const fixOf = (code: string) => problems.find((p) => p.code === code)?.fix ?? null;
  const mode = smsMode();
  const budget = sender ? Number(sender.monthlyBudgetUsd) : 0;
  const usd = (n: number) => `US$${n.toFixed(2)}`;

  const items: ReadinessItem[] = [
    {
      key: "sender",
      label: "SMS sender",
      ok: !!sender,
      detail: sender ? `Texts come from ${sender.identityLabel ?? "your sender"}` : "No sender chosen yet",
      fix: sender ? null : { label: "Choose an SMS sender", href: `${SETUP}?step=sender` },
      optional: false,
      waiting: false,
    },
    {
      key: "verification",
      label: "Messaging verification",
      ok: !!sender && !has("sender_unverified") && !has("no_countries"),
      detail: !sender ? "Needs a sender first" : has("sender_unverified") ? "Waiting for verification" : has("no_countries") ? "No countries to send to yet" : "Verified",
      fix: has("sender_unverified") ? fixOf("sender_unverified") : has("no_countries") ? fixOf("no_countries") : !sender ? { label: "Choose an SMS sender", href: `${SETUP}?step=sender` } : null,
      optional: false,
      waiting: false,
    },
    {
      key: "permissions",
      label: "Customer messaging permissions",
      ok: !has("no_basis"),
      detail: has("no_basis") ? "Not chosen yet for order updates" : `${BASIS_WORDS[sender?.transactionalBasis ?? ""] ?? "Chosen"}. Marketing texts only reach customers subscribed in Shopify.`,
      fix: has("no_basis") ? fixOf("no_basis") : null,
      optional: false,
      waiting: false,
    },
    {
      key: "limit",
      label: "Monthly messaging limit",
      ok: budget > 0 && !has("budget_used"),
      detail: budget > 0 ? `${usd(budget)} a month · ${usd(spend.totalUsd)} used${sender?.monthlyMessageQuota ? ` · at most ${sender.monthlyMessageQuota} texts` : ""}` : "Not set (nothing is sent with a limit of 0)",
      fix: budget <= 0 ? fixOf("no_budget") : has("budget_used") ? fixOf("budget_used") : null,
      optional: false,
      waiting: false,
    },
    {
      key: "sending",
      label: "Automatic SMS",
      ok: !!sender?.sendingEnabled,
      detail: sender?.sendingEnabled ? "On" : "Off: no automatic texts go out",
      fix: sender?.sendingEnabled ? null : { label: "Turn on automatic SMS", href: `${SETUP}?step=automate` },
      optional: false,
      waiting: false,
    },
    {
      key: "account",
      label: "Messaging account",
      ok: mode === "live" && account.reachable && !account.sandbox,
      detail:
        mode === "off"
          ? "Not available yet"
          : mode === "sandbox" || account.sandbox
            ? "Still being verified: test messages reach approved test recipients until it's done"
            : account.reachable
              ? "Verified"
              : "We couldn't reach the SMS provider just now",
      fix: null,
      optional: false,
      waiting: !(mode === "live" && account.reachable && !account.sandbox),
    },
    {
      key: "test_recipient",
      label: "Test recipient",
      ok: testNumbers > 0,
      detail: testNumbers ? `${testNumbers} approved` : "None yet: add your own mobile to try messages",
      fix: testNumbers ? null : { label: "Add a test recipient", href: "/messaging/settings#test-recipients" },
      optional: true,
      waiting: false,
    },
  ];

  const setupMissing = items.some((i) => !i.optional && !i.ok && i.key !== "account");
  const temporary = problems.some((p) => p.kind === "temporary");
  const testMode = mode !== "live" || account.sandbox;
  const status: ReadinessStatus = setupMissing ? "setup_required" : temporary ? "action_required" : testMode || !account.reachable ? "setup_required" : "ready";
  const itemCodes = new Set(["no_sender", "sender_unverified", "no_countries", "no_basis", "no_budget", "sending_off", "test_mode", "platform_off"]);
  return {
    status,
    ready: status === "ready" && !problems.some((p) => p.stops === "all"),
    testMode,
    sender: !!sender,
    verification: items[1]!.ok,
    budget: budget > 0,
    consent: items[2]!.ok,
    sending: items[4]!.ok,
    testNumber: testNumbers > 0,
    items,
    problems: problems.filter((p) => !itemCodes.has(p.code)),
  };
}

// ---------------------------------------------------------------------------
// One automation's checks before it is switched on
// ---------------------------------------------------------------------------

export interface AutomationCheck {
  key: string;
  label: string;
  ok: boolean;
  message: string;
  fix: { label: string; href: string } | null;
  /** It keeps the automation from being switched on now (activateAutomation refuses it too). */
  blocking: boolean;
}

/**
 * The review step's checks: the automation's own (trigger, who it's for, message, details) and the
 * store's (sender, verification, provider, monthly limit, permissions, opt-outs, numbers, account).
 * `canActivate` is what activateAutomation will say, so the button and the API agree.
 */
export async function validateAutomation(store: Store, id: string, deps: Pick<SmsDeps, "coord" | "fetchImpl" | "sms">): Promise<{ canActivate: boolean; checks: AutomationCheck[] }> {
  const a = await automationOf(store, id);
  const checks: AutomationCheck[] = [];
  const add = (key: string, label: string, ok: boolean, message: string, opts: { fix?: AutomationCheck["fix"]; blocking?: boolean } = {}) =>
    checks.push({ key, label, ok, message, fix: ok ? null : (opts.fix ?? null), blocking: !ok && !!opts.blocking });
  const edit = (step: string) => ({ label: "Fix this", href: `/messaging/automations/edit?id=${id}&step=${step}` });

  if (!a.config || !a.trigger) {
    add("settings", "Automation settings", false, "This automation's settings are no longer valid: open it and save it again.", { fix: edit("trigger"), blocking: true });
    return { canActivate: false, checks };
  }
  const cfg = a.config;
  const category: SmsCategory = TRIGGER_INFO[cfg.trigger].category;

  // The automation's own. What Shopify last said, without asking it again: looking changes nothing
  // (activating asks Shopify where it hasn't been asked yet).
  const cap = (await triggerCapabilities(store, deps.coord)).find((c) => c.trigger === cfg.trigger)!;
  const askable = cap.state === "unchecked";
  add("trigger", "Trigger", cap.state === "ready" || askable, cap.state === "ready" ? "Shopify tells bizinsights when this happens in your store." : askable ? "Checked with Shopify when you activate it." : (cap.reason ?? "Shopify doesn't send this event for your store."), {
    fix: edit("trigger"),
    blocking: true,
  });
  const audience = await audienceProblem(store.id, cfg.trigger, cfg.audience);
  add("audience", "Recipients", !audience, audience ?? a.audienceLabel ?? "The customer the event is about.", { fix: edit("audience"), blocking: true });
  const issues = checkAutomationMessage(cfg.body, cfg.trigger, cfg.discountCode).filter((i) => i.level === "error");
  const VARIABLE_CODES = new Set(["unsupported_variable", "unknown_variable", "malformed"]);
  const content = issues.filter((i) => !VARIABLE_CODES.has(i.code));
  const variables = issues.filter((i) => VARIABLE_CODES.has(i.code));
  add("message", "Message", !content.length, content[0]?.message ?? (category === "marketing" ? "Ready, with the opt-out link marketing texts need." : "Ready."), { fix: edit("message"), blocking: true });
  add("variables", "Personal details", !variables.length, variables[0]?.message ?? "Every detail in the message is one this event has.", { fix: edit("message"), blocking: true });

  // The store's: the same problems every page shows; on a live platform its own setup blocks switching on.
  const problems = (await sendingProblems(store)).filter((p) => p.stops === "all" || p.stops === category);
  const blockers = new Set(setupBlockers(problems, category).map((p) => p.code));
  const problemCheck = (key: string, label: string, codes: string[], okText: string) => {
    const p = problems.find((x) => codes.includes(x.code));
    add(key, label, !p, p?.message ?? okText, { fix: p?.fix ?? null, blocking: !!p && blockers.has(p.code) });
  };
  problemCheck("sender", "SMS sender", ["no_sender"], "Your store has an SMS sender.");
  problemCheck("sender_usable", "Sender can send", ["no_countries", "held", "sending_off"], "Your sender is switched on for your countries.");
  problemCheck("verification", "Messaging verification", ["sender_unverified"], "Your SMS sender is verified.");
  problemCheck("limit", "Monthly messaging limit", ["no_budget", "budget_used"], "Your monthly limit leaves room for more texts.");
  problemCheck("permissions", "Customer messaging permissions", category === "marketing" ? ["marketing_off", "marketing_platform_off"] : ["no_basis"], category === "marketing" ? "Only customers subscribed to your SMS marketing get it, each text with the opt-out link." : "You've said how customers agreed to order updates by text.");
  add("opt_outs", "Opt-outs", true, "Customers who opted out or replied STOP are skipped automatically, before every text.");
  add("numbers", "Mobile numbers", true, "Each customer's mobile number is checked before every text; texts never go to a number that isn't one.");

  const sender = await senderOf(store.id);
  const account = await accountStatus(smsRegion(sender), deps);
  const mode = smsMode();
  add("provider", "SMS provider connection", mode !== "off" && account.reachable, mode === "off" ? "SMS isn't available for your account yet." : account.reachable ? "bizinsights reaches the SMS provider for you." : "We couldn't reach the SMS provider just now. Try again in a few minutes.", {
    fix: { label: "View setup requirements", href: "/messaging/settings" },
  });
  add(
    "account",
    "Account can send",
    mode === "live" && !account.sandbox,
    mode === "live" && !account.sandbox
      ? "Your SMS account can text customers."
      : "Your SMS account is still being verified. Test messages can be sent to approved numbers until verification is complete; until then the automation records what it would send in Message History.",
    { fix: { label: "View setup requirements", href: "/messaging/settings" } },
  );
  return { canActivate: !checks.some((c) => c.blocking), checks };
}
