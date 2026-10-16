"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, fmtMoney, fmtNum } from "@/lib/api";
import { readLocal, removeLocal, writeLocal } from "@/lib/storage";
import { fmtRelative, plural } from "./format";
import { Icon, type IconName } from "./Icons";
import { Empty, Panel } from "./Primitives";
import type { AbandonedContact, ContactPerson, Contacts, CustomerContact } from "./types";

type Tab = "abandoned" | "subscribers" | "recent";

const TABS: Array<{ id: Tab; label: string; icon: IconName; empty: string; help: string }> = [
  {
    id: "abandoned",
    label: "Left at checkout",
    icon: "cart",
    empty: "Nobody has left a checkout unfinished recently. Nice!",
    help: "Shoppers who started checkout but didn't pay. Each has a link back to their saved cart: send it, and they carry on exactly where they stopped.",
  },
  {
    id: "subscribers",
    label: "Newsletter sign-ups",
    icon: "mail",
    empty: "No newsletter sign-ups yet.",
    help: "Customers who agreed to hear from you by email.",
  },
  {
    id: "recent",
    label: "Newest customers",
    icon: "users",
    empty: "No customers yet.",
    help: "The most recent people to create a customer record in your store.",
  },
];

/**
 * What gets sent, per tab. {name}, {store}, {items}, {total} and {link} are filled in for each
 * person; the merchant can rewrite the rest, and it's remembered in this browser.
 */
const DEFAULT_MESSAGE: Record<Tab, string> = {
  abandoned:
    "Hi {name}, you left {items} in your cart at {store}. It's saved for you, so you can finish your order right here: {link}\n\nIf anything stopped you, just reply and we'll help.",
  subscribers: "Hi {name}, thanks for signing up to hear from {store}! ",
  recent: "Hi {name}, thanks for shopping with {store}! If there's anything we can help with, just reply to this message.",
};

const SUBJECT: Record<Tab, string> = {
  abandoned: "Your cart at {store} is saved for you",
  subscribers: "A note from {store}",
  recent: "Thanks from {store}",
};

const messageKey = (storeId: string, tab: Tab) => `insights:contact-message:${storeId}:${tab}`;

const readMessage = (storeId: string, tab: Tab): string => readLocal(messageKey(storeId, tab)) || DEFAULT_MESSAGE[tab];

/** Storage blocked: the edit still applies until the page is closed. */
function saveMessage(storeId: string, tab: Tab, text: string) {
  if (text === DEFAULT_MESSAGE[tab]) removeLocal(messageKey(storeId, tab));
  else writeLocal(messageKey(storeId, tab), text);
}

const firstName = (p: ContactPerson) => p.name?.split(/\s+/)[0] ?? "there";

/** The template with this person's details filled in. */
function fill(template: string, p: ContactPerson, storeName: string, abandoned?: AbandonedContact): string {
  const items = abandoned?.items.length
    ? abandoned.items.map((i) => `${i.title}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`).join(", ")
    : "a few things";
  return template
    .replaceAll("{name}", firstName(p))
    .replaceAll("{store}", storeName)
    .replaceAll("{items}", items)
    .replaceAll("{total}", abandoned ? fmtMoney(abandoned.total, abandoned.currency) : "")
    .replaceAll("{link}", abandoned?.recoveryUrl ?? "")
    .trim();
}

/** "+61 400 000 000" → "61400000000": what wa.me wants (country code, digits only). */
const waNumber = (phone: string) => phone.replace(/^00/, "+").replace(/[^\d]/g, "");
const telNumber = (phone: string) => phone.replace(/[^\d+]/g, "");

/** Two letters for the avatar: initials of the name, else the start of the email. */
function initials(p: ContactPerson) {
  const src = p.name ?? p.email ?? "?";
  const words = src.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** A steady colour per person, so the same shopper always looks the same. */
function hue(p: ContactPerson) {
  const key = p.email ?? p.phone ?? p.name ?? p.customerId ?? "";
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function useCopied(): [boolean, (text: string) => Promise<void>] {
  const [done, setDone] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      window.setTimeout(() => setDone(false), 1500);
    } catch {
      // Clipboard blocked: the text is on screen to select by hand.
    }
  };
  return [done, copy];
}

function IconButton({ label, icon, onClick, href, external }: { label: string; icon: IconName; onClick?: () => void; href?: string; external?: boolean }) {
  const cls = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition hover:border-accent hover:text-accent";
  if (href) {
    return (
      <a className={cls} href={href} title={label} aria-label={label} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        <Icon name={icon} className="h-4 w-4" />
      </a>
    );
  }
  return (
    <button type="button" className={cls} title={label} aria-label={label} onClick={onClick}>
      <Icon name={icon} className="h-4 w-4" />
    </button>
  );
}

function CopyIcon({ text, label }: { text: string; label: string }) {
  const [done, copy] = useCopied();
  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition hover:border-accent hover:text-accent"
      title={label}
      aria-label={label}
      onClick={() => void copy(text)}
    >
      <Icon name={done ? "check" : "copy"} className={`h-4 w-4 ${done ? "text-good" : ""}`} />
    </button>
  );
}

/** Email or phone, each in its own box, with whether the person agreed to marketing on it. */
function ContactBox({ kind, value, agreed }: { kind: "email" | "phone"; value: string | null; agreed: boolean }) {
  const label = kind === "email" ? "Email" : "Phone";
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <Icon name={kind === "email" ? "mail" : "phone"} className="h-3.5 w-3.5" />
        {label}
      </p>
      {value ? (
        <>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <a
              className="min-w-0 truncate font-medium hover:text-accent hover:underline"
              href={kind === "email" ? `mailto:${value}` : `tel:${telNumber(value)}`}
              data-testid={`contact-${kind}`}
            >
              {value}
            </a>
            <CopyIcon text={value} label={`Copy ${value}`} />
          </div>
          <p className={`mt-0.5 text-[11px] ${agreed ? "text-good" : "text-muted"}`}>
            {kind === "email" ? (agreed ? "Agreed to marketing emails" : "Hasn't agreed to marketing emails") : agreed ? "Agreed to marketing texts" : "Hasn't agreed to marketing texts"}
          </p>
        </>
      ) : (
        <p className="mt-0.5 text-sm text-muted">{kind === "email" ? "No email on file" : "No phone number on file"}</p>
      )}
    </div>
  );
}

function SendButton({ label, icon, href, onClick, disabledReason, primary, testId }: { label: string; icon: IconName; href?: string | null; onClick?: () => void; disabledReason?: string | null; primary?: boolean; testId: string }) {
  const cls = `inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition ${
    disabledReason ? "cursor-not-allowed border border-dashed border-border text-muted opacity-60" : primary ? "bg-accent text-accent-ink hover:opacity-90" : "border border-border bg-surface hover:border-accent hover:text-accent"
  }`;
  if (disabledReason) {
    return (
      <span className={cls} title={disabledReason} aria-disabled="true" data-testid={testId}>
        <Icon name={icon} className="h-4 w-4" />
        {label}
      </span>
    );
  }
  if (href) {
    return (
      <a className={cls} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" data-testid={testId}>
        <Icon name={icon} className="h-4 w-4" />
        {label}
      </a>
    );
  }
  return (
    <button type="button" className={cls} onClick={onClick} data-testid={testId}>
      <Icon name={icon} className="h-4 w-4" />
      {label}
    </button>
  );
}

type Shown = NonNullable<Contacts["shown"]>;
const ALL_SHOWN: Shown = { abandoned: true, customers: true, names: true, contact: true, orders: true };

function ContactRow({
  p,
  i,
  tab,
  template,
  storeName,
  abandoned,
  customer,
  shown = ALL_SHOWN,
}: {
  p: ContactPerson;
  i: number;
  tab: Tab;
  template: string;
  storeName: string;
  abandoned?: AbandonedContact;
  customer?: CustomerContact;
  /** What this member may see (Team & Access): hidden details are said to be hidden, not missing. */
  shown?: Shown;
}) {
  const h = hue(p);
  const when = fmtRelative(abandoned?.createdAt ?? customer?.createdAt);
  const message = fill(template, p, storeName, abandoned);
  const subject = fill(SUBJECT[tab], p, storeName, abandoned);
  const [copiedMessage, copyMessage] = useCopied();
  const [copiedLink, copyLink] = useCopied();
  const [canShare, setCanShare] = useState(false);
  useEffect(() => setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function"), []);

  const whatsapp = p.phone ? `https://wa.me/${waNumber(p.phone)}?text=${encodeURIComponent(message)}` : null;
  const email = p.email ? `mailto:${p.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}` : null;
  // "?&body=" is the form both iPhone and Android Messages read.
  const sms = p.phone ? `sms:${telNumber(p.phone)}?&body=${encodeURIComponent(message)}` : null;
  const best = whatsapp ? "whatsapp" : email ? "email" : "sms";

  return (
    <li className="animate-rise rounded-xl border border-border bg-surface p-4" style={{ ["--i" as string]: Math.min(i, 8) }} data-testid="contact-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-sm"
            style={{ background: `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 45) % 360} 62% 42%))` }}
          >
            {initials(p)}
          </span>
          <div className="min-w-0">
            <p className={`truncate font-medium ${p.name ? "" : "text-muted"}`}>{p.name ?? (!shown.names && p.customerId ? `Customer #${p.customerId}` : "Guest shopper")}</p>
            {abandoned && abandoned.items.length > 0 && (
              <p className="truncate text-xs text-muted">{abandoned.items.map((it) => `${it.title}${it.quantity > 1 ? ` ×${it.quantity}` : ""}`).join(" · ")}</p>
            )}
            {customer && customer.orders !== null && <p className="text-xs text-muted">{customer.orders > 0 ? `${plural(customer.orders, "order")} so far` : "No orders yet"}</p>}
          </div>
        </div>
        <div className="text-right">
          {abandoned && <p className="font-semibold tabular-nums">{fmtMoney(abandoned.total, abandoned.currency)}</p>}
          {customer && customer.orders !== null && customer.orders > 0 && <p className="font-semibold tabular-nums">{fmtMoney(customer.spent, customer.currency ?? undefined)}</p>}
          <p className="text-xs text-muted">{abandoned ? `left ${when ?? ""}` : `joined ${when ?? ""}`}</p>
        </div>
      </div>

      {!shown.contact ? (
        <p className="mt-3 text-xs text-muted" data-testid="contact-hidden">Contact details aren&apos;t shared with you.</p>
      ) : (
      <>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <ContactBox kind="email" value={p.email} agreed={p.subscribed} />
        <ContactBox kind="phone" value={p.phone} agreed={p.smsSubscribed} />
      </div>

      {abandoned?.recoveryUrl && (
        <div className="mt-2 rounded-lg border border-border bg-bg px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Icon name="link" className="h-3.5 w-3.5" />
            Link back to their cart: opens checkout with everything still in it
          </p>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <a className="min-w-0 truncate font-mono text-xs text-accent hover:underline" href={abandoned.recoveryUrl} target="_blank" rel="noopener noreferrer" data-testid="recovery-link">
              {abandoned.recoveryUrl}
            </a>
            <div className="flex shrink-0 gap-1.5">
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-muted transition hover:border-accent hover:text-accent"
                onClick={() => void copyLink(abandoned.recoveryUrl!)}
              >
                <Icon name={copiedLink ? "check" : "copy"} className={`h-3.5 w-3.5 ${copiedLink ? "text-good" : ""}`} />
                {copiedLink ? "Copied" : "Copy link"}
              </button>
              <IconButton label="Open the checkout" icon="external" href={abandoned.recoveryUrl!} external />
            </div>
          </div>
        </div>
      )}

      <div className="mt-3">
        <p className="mb-1.5 text-xs font-medium text-muted">{abandoned ? "Send them the link to finish their purchase" : "Get in touch"}</p>
        <div className="flex flex-wrap items-center gap-2">
          <SendButton label="WhatsApp" icon="chat" href={whatsapp} disabledReason={whatsapp ? null : "No phone number"} primary={best === "whatsapp"} testId="send-whatsapp" />
          <SendButton label="Email" icon="mail" href={email} disabledReason={email ? null : "No email address"} primary={best === "email"} testId="send-email" />
          <SendButton label="Text message" icon="phone" href={sms} disabledReason={sms ? null : "No phone number"} primary={best === "sms"} testId="send-sms" />
          {canShare && (
            <SendButton
              label="Other apps"
              icon="share"
              onClick={() => void navigator.share({ title: subject, text: message }).catch(() => undefined)}
              testId="send-share"
            />
          )}
          <SendButton label={copiedMessage ? "Copied" : "Copy message"} icon={copiedMessage ? "check" : "copy"} onClick={() => void copyMessage(message)} testId="copy-message" />
          {p.adminUrl && <IconButton label="Open in Shopify" icon="external" href={p.adminUrl} external />}
        </div>
      </div>
      </>
      )}
    </li>
  );
}

/** Edit the message every send button uses on this tab. */
function MessageEditor({ tab, value, onChange }: { tab: Tab; value: string; onChange: (v: string) => void }) {
  const tokens = tab === "abandoned" ? ["{name}", "{items}", "{total}", "{link}", "{store}"] : ["{name}", "{store}"];
  return (
    <details className="mt-3 rounded-lg border border-border bg-bg px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Your message <span className="font-normal text-muted">(tap to change what gets sent)</span></summary>
      <textarea
        className="input mt-2 min-h-28 font-normal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Message to send"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <p>
          Filled in for each person:{" "}
          {tokens.map((t) => (
            <code key={t} className="mr-1 rounded border border-border bg-surface px-1">{t}</code>
          ))}
        </p>
        {value !== DEFAULT_MESSAGE[tab] && (
          <button type="button" className="underline" onClick={() => onChange(DEFAULT_MESSAGE[tab])}>Back to the suggested message</button>
        )}
      </div>
    </details>
  );
}

function Skeleton() {
  return (
    <ul className="mt-3 space-y-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li key={i} className="space-y-3 rounded-xl border border-border p-4">
          <span className="flex items-center gap-3">
            <span className="skeleton h-10 w-10 shrink-0 rounded-full" />
            <span className="skeleton block h-3 w-40" />
          </span>
          <span className="grid gap-2 sm:grid-cols-2">
            <span className="skeleton block h-14" />
            <span className="skeleton block h-14" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function CopyAll({ values, what }: { values: string[]; what: string }) {
  const [done, copy] = useCopied();
  return (
    <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline" onClick={() => void copy(values.join(", "))}>
      <Icon name={done ? "check" : "copy"} className="h-3.5 w-3.5" />
      {done ? "Copied" : `Copy all ${values.length} ${what}`}
    </button>
  );
}

const Note = ({ children }: { children: ReactNode }) => (
  <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
    <Icon name="sparkle" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-2" />
    <span>{children}</span>
  </p>
);

/**
 * People who gave the store a way to reach them, with one-tap ways to get back in touch: the
 * link back to an unfinished checkout by WhatsApp, email, text message or any other app.
 * Loaded when the card appears and on "Refresh" (not on the dashboard's 15-second poll): it's a
 * live call to Shopify, and the data is personal, so we fetch it only when someone is looking.
 * Messages are sent from the merchant's own apps; bizinsights never sends or stores them.
 */
export function ContactsCard({ storeId, storeName, shopDomain }: { storeId: string; storeName: string; shopDomain: string }) {
  const { workspace, allowed: may } = useApp();
  // Team & Access: the customer lists and the unfinished checkouts each need their own permission.
  const tabs = TABS.filter((t) => (t.id === "abandoned" ? may("analytics.abandonment") : may("customers.list")));
  const allowed = tabs.length > 0;
  const [chosen, setTab] = useState<Tab>("abandoned");
  const tab = tabs.some((t) => t.id === chosen) ? chosen : (tabs[0]?.id ?? "abandoned");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [templates, setTemplates] = useState<Record<Tab, string>>(DEFAULT_MESSAGE);
  const path = `/workspaces/${workspace.id}/stores/${storeId}/contacts`;
  // Kept with the store it is for (like useApi): after a store switch the previous store's
  // customers never show under the new one, and a late answer for it is dropped.
  const [answer, setAnswer] = useState<{ path: string; value: Contacts } | null>(null);
  const data = answer?.path === path ? answer.value : null;
  const asked = useRef(path);

  const load = useCallback(async () => {
    asked.current = path;
    setLoading(true);
    setError(null);
    try {
      const value = await api<Contacts>(path);
      if (asked.current === path) setAnswer({ path, value });
    } catch (e) {
      if (asked.current === path) setError(actionError(e, "load your customers"));
    } finally {
      if (asked.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  // The merchant's own wording, if they changed it before (per store, in this browser).
  useEffect(() => {
    setTemplates({ abandoned: readMessage(storeId, "abandoned"), subscribers: readMessage(storeId, "subscribers"), recent: readMessage(storeId, "recent") });
  }, [storeId]);

  const help = "People who gave your store a way to reach them, so you can get back in touch. Fetched from Shopify each time; bizinsights doesn't keep a copy, and messages go from your own apps.";
  if (!allowed) {
    return (
      <Panel id="contacts" title="Customers to follow up" help={help}>
        <Empty>Customer lists aren&apos;t shared with you. Ask an owner or admin of the workspace if you need them.</Empty>
      </Panel>
    );
  }

  const lists = { abandoned: data?.abandoned ?? [], subscribers: data?.subscribers ?? [], recent: data?.recent ?? [] };
  const shown: Shown = data?.shown ?? ALL_SHOWN;
  const current = TABS.find((t) => t.id === tab)!;
  const people: ContactPerson[] = lists[tab];
  const emails = people.map((x) => x.email).filter((e): e is string => !!e);
  const phones = people.map((x) => x.phone).filter((e): e is string => !!e);
  const setTemplate = (text: string) => {
    setTemplates((t) => ({ ...t, [tab]: text }));
    saveMessage(storeId, tab, text);
  };

  return (
    <Panel
      id="contacts"
      title="Customers to follow up"
      help={help}
      aside={
        <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => void load()} disabled={loading}>
          <Icon name="refresh" className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          {loading ? "Refreshing…" : data ? `Updated ${fmtRelative(data.fetchedAt) ?? "just now"}` : "Refresh"}
        </button>
      }
    >
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg p-1" role="tablist" aria-label="Which customers">
        {tabs.map((t) => {
          const n = lists[t.id].length;
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition ${active ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-text"}`}
            >
              <Icon name={t.icon} className={`h-4 w-4 ${active ? "text-accent" : ""}`} />
              {t.label}
              {data && !data.restricted && <span className={`rounded-full px-1.5 text-xs tabular-nums ${active ? "bg-accent text-accent-ink" : "bg-border"}`}>{fmtNum(n)}{n >= 25 ? "+" : ""}</span>}
            </button>
          );
        })}
      </div>

      <p className="mt-3 text-xs text-muted">{current.help}</p>

      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {!data && loading && <Skeleton />}
      {data?.restricted && (
        <div className="mt-3">
          <Alert kind="info">
            Shopify hasn&apos;t approved bizinsights to show customers&apos; names, emails and phone numbers for this store yet. You can still see them in{" "}
            <a className="underline" href={`https://${shopDomain}/admin/${tab === "abandoned" ? "checkouts" : "customers"}`} target="_blank" rel="noopener noreferrer">your Shopify admin</a>.
          </Alert>
        </div>
      )}
      {data && !data.restricted && (
        people.length === 0 ? (
          <div className="mt-3"><Empty>{current.empty}</Empty></div>
        ) : (
          <>
            {shown.contact && <MessageEditor tab={tab} value={templates[tab]} onChange={setTemplate} />}
            {shown.contact && (emails.length > 1 || phones.length > 1) && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {emails.length > 1 && <CopyAll values={emails} what="emails" />}
                {phones.length > 1 && <CopyAll values={phones} what="phone numbers" />}
              </div>
            )}
            <ul key={tab} className="mt-3 space-y-3" aria-label={current.label}>
              {tab === "abandoned"
                ? lists.abandoned.map((a, i) => <ContactRow key={a.id} p={a} i={i} tab={tab} template={templates[tab]} storeName={storeName} abandoned={a} shown={shown} />)
                : lists[tab].map((c, i) => <ContactRow key={c.customerId ?? i} p={c} i={i} tab={tab} template={templates[tab]} storeName={storeName} customer={c} shown={shown} />)}
            </ul>
          </>
        )
      )}
      {data && !data.restricted && shown.contact && (
        <Note>
          WhatsApp, Email and Text message open your own app with the message ready: check it and press send. Rules differ by country: send offers only
          to people who agreed (shown under each email and phone number), and keep cart reminders short and personal.
        </Note>
      )}
    </Panel>
  );
}
