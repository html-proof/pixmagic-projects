"use client";
import { useCallback, useEffect, useState } from "react";
import { can } from "@app/shared/roles";
import { useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { actionError, api, fmtMoney, fmtNum } from "@/lib/api";
import { fmtRelative, plural } from "./format";
import { Icon, type IconName } from "./icons";
import { Empty, Panel } from "./primitives";
import type { AbandonedContact, ContactPerson, Contacts, CustomerContact } from "./types";

type Tab = "abandoned" | "subscribers" | "recent";

const TABS: Array<{ id: Tab; label: string; icon: IconName; empty: string; help: string }> = [
  {
    id: "abandoned",
    label: "Left at checkout",
    icon: "cart",
    empty: "Nobody has left a checkout unfinished recently. Nice!",
    help: "Shoppers who typed their email at checkout but didn't pay. Each one has a link back to their saved cart.",
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

/** Two letters for the avatar: initials of the name, else the start of the email. */
function initials(p: ContactPerson) {
  const src = p.name ?? p.email ?? "?";
  const words = src.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

/** A steady colour per person, so the same shopper always looks the same. */
function hue(p: ContactPerson) {
  const key = p.email ?? p.name ?? p.customerId ?? "";
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const firstName = (p: ContactPerson) => p.name?.split(/\s+/)[0] ?? "there";

function mailto(p: ContactPerson, storeName: string, abandoned?: AbandonedContact) {
  if (!p.email) return null;
  const subject = abandoned ? `Your cart at ${storeName}` : `Hello from ${storeName}`;
  const things = abandoned?.items.length ? abandoned.items.map((i) => i.title).join(", ") : "a few things";
  const body = abandoned
    ? `Hi ${firstName(p)},\n\nYou left ${things} in your cart at ${storeName}. It's saved for you here:\n${abandoned.recoveryUrl}\n\nIf anything stopped you, just reply to this email and we'll help.\n`
    : `Hi ${firstName(p)},\n\n`;
  return `mailto:${p.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function CopyButton({ text, label, icon = "copy" }: { text: string; label: string; icon?: IconName }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted transition hover:border-accent hover:text-accent"
      title={label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard blocked: the address is on screen to select by hand.
        }
      }}
    >
      <Icon name={done ? "check" : icon} className={`h-4 w-4 ${done ? "text-good" : ""}`} />
    </button>
  );
}

function PersonRow({ p, i, storeName, abandoned, customer }: { p: ContactPerson; i: number; storeName: string; abandoned?: AbandonedContact; customer?: CustomerContact }) {
  const h = hue(p);
  const href = mailto(p, storeName, abandoned);
  const when = fmtRelative(abandoned?.createdAt ?? customer?.createdAt);
  return (
    <li className="animate-rise flex flex-col gap-3 py-3 sm:flex-row sm:items-center" style={{ ["--i" as string]: Math.min(i, 8) }} data-testid="contact-row">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white shadow-sm"
          style={{ background: `linear-gradient(135deg, hsl(${h} 62% 52%), hsl(${(h + 45) % 360} 62% 42%))` }}
        >
          {initials(p)}
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className={`truncate font-medium ${p.name ? "" : "text-muted"}`}>{p.name ?? "Guest shopper"}</span>
            {p.subscribed ? (
              <span className="rounded-full bg-good/12 px-2 py-0.5 text-[11px] font-medium text-good">Subscribed</span>
            ) : (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">Not subscribed</span>
            )}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-muted">
            {p.email && (
              <a className="truncate hover:text-accent hover:underline" href={`mailto:${p.email}`}>{p.email}</a>
            )}
            {p.phone && (
              <a className="whitespace-nowrap hover:text-accent hover:underline" href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>{p.phone}</a>
            )}
            {!p.email && !p.phone && <span>No email or phone on file</span>}
          </p>
          {abandoned && abandoned.items.length > 0 && (
            <p className="mt-0.5 truncate text-xs text-muted">
              {abandoned.items.map((it) => `${it.title}${it.quantity > 1 ? ` ×${it.quantity}` : ""}`).join(" · ")}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-4 pl-13 sm:justify-end sm:pl-0">
        <div className="text-right text-sm">
          {abandoned && <p className="font-semibold tabular-nums">{fmtMoney(abandoned.total, abandoned.currency)}</p>}
          {customer && (
            <p className="font-semibold tabular-nums">
              {customer.orders > 0 ? fmtMoney(customer.spent, customer.currency ?? undefined) : "No orders yet"}
            </p>
          )}
          <p className="text-xs text-muted">
            {customer && customer.orders > 0 ? `${plural(customer.orders, "order")} · ` : ""}
            {when}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {href && (
            <a className="btn-primary h-8 px-3 text-xs" href={href} title={abandoned ? "Email them a link back to their cart" : "Write them an email"}>
              <Icon name="mail" className="h-4 w-4" /> Email
            </a>
          )}
          {p.email && <CopyButton text={p.email} label={`Copy ${p.email}`} />}
          {abandoned && <CopyButton text={abandoned.recoveryUrl} label="Copy the link back to their cart" icon="link" />}
          {p.adminUrl && (
            <a
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted transition hover:border-accent hover:text-accent"
              href={p.adminUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in Shopify"
              aria-label="Open in Shopify"
            >
              <Icon name="external" className="h-4 w-4" />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

function Skeleton() {
  return (
    <ul className="divide-y divide-border" aria-hidden>
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-3 py-3">
          <span className="skeleton h-10 w-10 shrink-0 rounded-full" />
          <span className="flex-1 space-y-2">
            <span className="skeleton block h-3 w-40" />
            <span className="skeleton block h-3 w-56" />
          </span>
          <span className="skeleton h-8 w-20" />
        </li>
      ))}
    </ul>
  );
}

/**
 * People who gave the store their email, with one-click ways to get back in touch. Loaded when
 * the card appears and on "Refresh" (not on the dashboard's 15-second poll): it's a live call to
 * Shopify, and the data is personal, so we fetch it only when someone is looking.
 */
export function ContactsCard({ storeId, storeName, shopDomain }: { storeId: string; storeName: string; shopDomain: string }) {
  const { workspace } = useApp();
  const allowed = can(workspace.role, "customers:contact");
  const [tab, setTab] = useState<Tab>("abandoned");
  const [data, setData] = useState<Contacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = `/workspaces/${workspace.id}/stores/${storeId}/contacts`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<Contacts>(path));
    } catch (e) {
      setError(actionError(e, "load your customers"));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  const help = "People who gave your store their email, so you can get back in touch. Fetched from Shopify each time; Insights doesn't keep a copy.";
  if (!allowed) {
    return (
      <Panel id="contacts" title="Customers to follow up" help={help}>
        <Empty>Ask a workspace owner, admin or analyst to see customers&apos; contact details.</Empty>
      </Panel>
    );
  }

  const lists = { abandoned: data?.abandoned ?? [], subscribers: data?.subscribers ?? [], recent: data?.recent ?? [] };
  const current = TABS.find((t) => t.id === tab)!;
  const subscribedEmails = lists.subscribers.map((s) => s.email).filter((e): e is string => !!e);

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
        {TABS.map((t) => {
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">{current.help}</p>
        {tab === "subscribers" && subscribedEmails.length > 1 && <CopyAll emails={subscribedEmails} />}
      </div>

      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      {!data && loading && <Skeleton />}
      {data?.restricted && (
        <div className="mt-3">
          <Alert kind="info">
            Shopify hasn&apos;t approved Insights to show customers&apos; names and emails for this store yet. You can still see them in{" "}
            <a className="underline" href={`https://${shopDomain}/admin/${tab === "abandoned" ? "checkouts" : "customers"}`} target="_blank" rel="noopener noreferrer">your Shopify admin</a>.
          </Alert>
        </div>
      )}
      {data && !data.restricted && (
        lists[tab].length === 0 ? (
          <div className="mt-3"><Empty>{current.empty}</Empty></div>
        ) : (
          <ul key={tab} className="mt-1 divide-y divide-border" aria-label={current.label}>
            {tab === "abandoned"
              ? lists.abandoned.map((a, i) => <PersonRow key={a.id} p={a} i={i} storeName={storeName} abandoned={a} />)
              : lists[tab].map((c, i) => <PersonRow key={c.customerId ?? i} p={c} i={i} storeName={storeName} customer={c} />)}
          </ul>
        )
      )}
      {data && !data.restricted && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
          <Icon name="sparkle" className="h-3.5 w-3.5 text-accent-2" />
          Only send offers and promotions to people marked Subscribed: they agreed to hear from you.
        </p>
      )}
    </Panel>
  );
}

function CopyAll({ emails }: { emails: string[] }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(emails.join(", "));
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          // Clipboard blocked.
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} className="h-3.5 w-3.5" />
      {done ? "Copied" : `Copy all ${emails.length} emails`}
    </button>
  );
}
