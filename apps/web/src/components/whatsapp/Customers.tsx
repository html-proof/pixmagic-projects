"use client";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Search, Send } from "lucide-react";
import { CUSTOMER_PHONE_SOURCE_LABEL, formatPhone, phoneCodeTyped } from "@app/shared/messaging";
import { WA_ORDER_UPDATE_INFO } from "@app/shared/whatsapp";
import { ConfirmDialog, Dialog, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge, Empty, type Tone } from "@/components/dashboard/Primitives";
import { Alert } from "@/components/ui";
import { api, ApiError, fmtMoney, fmtNum, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, plural } from "@/components/messaging/MessagingUi";
import { Composer } from "./Messages";
import type { WaContact, WaCustomersPage, WaCustomerWhatsapp, WaOverview, WaShopifyCustomer, WaSuppression } from "./types";
import { fmtAgo, useWaAction, waError, waHref } from "./WaUi";

// ---------------------------------------------------------------------------
// Customers, in two views:
//  - All customers: the store's customers, read live from Shopify a page at a time, each with the
//    whole phone number Shopify has for them (their profile, a checkout, their address, their last
//    order), where it came from, and what WhatsApp knows of it. Owners and admins can message one
//    from here. bizinsights keeps no copy of the list.
//  - Consent records: the customers WhatsApp keeps a record of (it messaged them, they wrote, their
//    consent was recorded), who agreed to what (docs/whatsapp.md, "Consent"), and recording consent
//    given another way.
// Then the store's do-not-message list, whose numbers stay masked (it keeps no whole number).
// Whole numbers show only to members allowed to see contact details (the tab needs it). A search
// can be a phone number, so it goes to the API in a header, never in an address. A member who may
// not see names may search by phone number only (a name searched for would give its number).
// ---------------------------------------------------------------------------

const MARKETING: Record<WaContact["marketing"], { tone: Tone; label: string }> = {
  opted_in: { tone: "good", label: "Agreed to marketing" },
  opted_out: { tone: "neutral", label: "Said no to marketing" },
  unknown: { tone: "neutral", label: "Marketing not asked" },
};

const SCOPE_LABEL: Record<string, string> = { all: "Every message", order_updates: "Order updates", marketing: "Marketing" };
const SUPPRESSION_SCOPE: Record<string, string> = { all: "Every message", marketing: "Marketing only" };
const SUPPRESSION_REASON: Record<string, string> = { stop_reply: "Replied STOP", merchant: "Added by your team", invalid_number: "Invalid number", redact: "Erased at the customer's request" };

type View = "all" | "consent";
const VIEWS: Array<{ id: View; label: string }> = [
  { id: "all", label: "All customers" },
  { id: "consent", label: "Consent records" },
];

export function Customers({ base, overview }: { base: string; overview: WaOverview }) {
  const [view, setView] = useState<View>("all");
  const manage = overview.can.manage;

  if (!overview.can.contacts) {
    return (
      <div className="card animate-rise">
        <h2 className="text-base font-semibold">Customers</h2>
        <p className="mt-1 text-sm text-muted">You don&apos;t have permission to see customers&apos; contact details. Ask an owner or admin for &quot;View contact information&quot; in Team &amp; Access.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg p-1 sm:w-fit" role="tablist" aria-label="Which customers">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
            className={`flex-1 shrink-0 rounded-lg px-3 py-1.5 text-sm transition sm:flex-none ${view === v.id ? "bg-surface font-medium shadow-sm" : "text-muted hover:text-text"}`}
          >
            {v.label}
          </button>
        ))}
      </div>
      {view === "all" ? <AllCustomers base={base} overview={overview} /> : <ConsentRecords base={base} overview={overview} />}
      <DoNotMessage base={base} manage={manage} />
    </div>
  );
}

/**
 * The pages of a list loaded so far, each page's whole answer kept. `search` goes in the `x-search`
 * header: it can be a phone number or an email, and an address ends up in logs and browser tools.
 * `last` is the latest answer of any search (kept while another loads or fails); `patch` changes
 * the rows loaded so far in place, every page kept, where `reload` starts again from the first.
 */
function usePages<P extends { nextCursor: string | null }>(path: string, search: string) {
  const key = `${path}\n${search}`;
  const [state, setState] = useState<{ key: string; pages: P[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(
    async (after: string | null) => {
      const request = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const sep = path.includes("?") ? "&" : "?";
        const page = await api<P>(`${path}${after ? `${sep}cursor=${encodeURIComponent(after)}` : ""}`, { headers: search ? { "x-search": encodeURIComponent(search) } : {} });
        if (request !== latest.current) return;
        setState((prev) => ({ key, pages: after && prev?.key === key ? [...prev.pages, page] : [page] }));
      } catch (e) {
        if (request === latest.current) setError(e);
      } finally {
        if (request === latest.current) setLoading(false);
      }
    },
    [key, path, search],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  const patch = useCallback((change: (page: P) => P) => setState((prev) => (prev?.key === key ? { key, pages: prev.pages.map(change) } : prev)), [key]);
  const pages = state?.key === key ? state.pages : null;
  const cursor = pages?.at(-1)?.nextCursor ?? null;
  return { pages, cursor, loading, error, last: state?.pages.at(-1) ?? null, loadMore: () => void load(cursor), reload: () => load(null), patch };
}

/** A search box with its own Search button (a phone's number keypad has no Return key); Clear also resets the filters `onClear` names. */
function SearchForm({ id, label, placeholder, inputMode, onSearch, onClear, active, children }: { id: string; label: string; placeholder: string; inputMode?: "tel" | "text"; onSearch: (text: string) => void; onClear?: () => void; active: boolean; children?: ReactNode }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(text.trim());
      }}
    >
      <div className="min-w-0 flex-1 sm:max-w-sm">
        <label className="label" htmlFor={id}>
          {label}
        </label>
        <input id={id} className="input" type="search" inputMode={inputMode} maxLength={80} placeholder={placeholder} value={text} onChange={(e) => (e.target.value ? setText(e.target.value) : (setText(""), onSearch("")))} />
      </div>
      {children}
      <button type="submit" className="btn-secondary">
        <Search size={16} aria-hidden /> Search
      </button>
      {active && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setText("");
            onSearch("");
            onClear?.();
          }}
        >
          Clear
        </button>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// All customers (from Shopify)
// ---------------------------------------------------------------------------

function AllCustomers({ base, overview }: { base: string; overview: WaOverview }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [composeTo, setComposeTo] = useState<{ phone: string; name: string | null } | null>(null);
  const sent = useRef(false);
  const list = usePages<WaCustomersPage>(`${base}/customers`, search);
  const first = list.pages?.[0];
  const seen = new Set<string>();
  const rows = (list.pages ?? []).flatMap((p) => p.customers).filter((r) => !seen.has(r.customerId) && !!seen.add(r.customerId));
  // What this member may see is on every answer, the first list's included, so it is known before
  // any search. Without names only a phone number may be searched (the API refuses anything else).
  const known = list.last?.shown ?? { names: true, orders: true };
  const shown = list.error instanceof ApiError && list.error.code === "phone_search_only" ? { ...known, names: false } : known;
  const canSend = overview.can.manage && overview.connection?.status === "connected";

  /** After a send: WhatsApp's record of that number read again, into its rows on every page loaded. */
  const refreshNumber = async (e164: string) => {
    try {
      const { contacts } = await api<{ contacts: WaContact[] }>(`${base}/contacts`, { headers: { "x-search": encodeURIComponent(e164) } });
      const c = contacts[0];
      if (c) list.patch((p) => ({ ...p, customers: p.customers.map((r) => (r.phoneE164 === e164 ? { ...r, whatsapp: whatsappOf(c, r.whatsapp) } : r)) }));
    } catch {
      // The rows stay as they were; the next time the list loads shows the change.
    }
  };

  return (
    <div className="space-y-4">
      <div className="card animate-rise space-y-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">All customers</h2>
          <p className="mt-1 text-sm text-muted">
            Your store&apos;s customers in Shopify, newest first, with the whole phone number Shopify has for each one. bizinsights reads them from Shopify each time you open this list
            and doesn&apos;t keep a copy.
          </p>
        </div>
        <SearchForm
          id={`${id}-search`}
          label={shown.names ? "Find a customer" : "Find a customer by phone number"}
          placeholder={shown.names ? "Name, email or phone number" : "+61 412 345 678"}
          inputMode={shown.names ? undefined : "tel"}
          onSearch={setSearch}
          active={!!search}
        />
      </div>

      {list.error ? (
        <CustomersError error={list.error} busy={list.loading} onRetry={() => void list.reload()} />
      ) : !list.pages || !first ? (
        <Skeleton lines={5} />
      ) : first.restricted ? (
        <Alert kind="info">
          Shopify hasn&apos;t approved bizinsights to show customers&apos; names and phone numbers for this store yet. You can still see them in{" "}
          <a className="underline" href={`${first.shopAdminUrl}/customers`} target="_blank" rel="noopener noreferrer">
            your Shopify admin
          </a>
          .
        </Alert>
      ) : !rows.length ? (
        <div className="card">
          <Empty>
            {!search
              ? "No customers in your store yet."
              : shown.names
                ? "No customer matches. Try their name, their email, or their whole phone number."
                : "No customer matches. Search with their whole phone number, including its country code."}
          </Empty>
        </div>
      ) : (
        <div className="card animate-rise space-y-3">
          <NumberSummary rows={rows} shopAdminUrl={first.shopAdminUrl} />
          <ul className="divide-y divide-border" aria-label="Customers">
            {rows.map((r) => (
              <CustomerRow
                key={r.customerId}
                r={r}
                showOrders={shown.orders}
                manage={overview.can.manage}
                canSend={canSend}
                onMessage={() => setComposeTo({ phone: r.phoneE164!, name: r.name })}
              />
            ))}
          </ul>
          {list.cursor && (
            <button type="button" className="btn-secondary w-full" onClick={list.loadMore} disabled={list.loading}>
              {list.loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}

      {composeTo && (
        <Composer
          base={base}
          overview={overview}
          initialPhone={composeTo.phone}
          initialName={composeTo.name}
          onClose={() => {
            const to = composeTo.phone;
            setComposeTo(null);
            // What WhatsApp knows of the number changed: read it again for its row alone, so the
            // pages loaded so far (and where the merchant was in them) stay.
            if (sent.current) void refreshNumber(to);
            sent.current = false;
          }}
          onSent={() => {
            sent.current = true;
          }}
        />
      )}
    </div>
  );
}

/** Why the list couldn't load, in the merchant's words: a permission Shopify must give, a store to reconnect, Shopify having a moment. */
function CustomersError({ error, busy, onRetry }: { error: unknown; busy: boolean; onRetry: () => void }) {
  const code = error instanceof ApiError ? error.code : null;
  // A search this member may not make (a name without "View customer profiles"), or a number that can't be read.
  if (code === "phone_search_only" || code === "invalid_phone") return <Alert kind="info">{waError(error, "search your customers")}</Alert>;
  if (code === "missing_scopes") {
    return (
      <Alert kind="info">
        bizinsights needs access to your customers in Shopify to list them here. Allow it in{" "}
        <Link className="underline" href="/settings/stores">
          Settings → Stores
        </Link>
        , then come back.
      </Alert>
    );
  }
  if (code === "store_disconnected" || code === "shopify_unavailable") {
    return (
      <Alert>
        {waError(error, "load your customers")}{" "}
        <button type="button" className="underline" onClick={onRetry} disabled={busy}>
          {busy ? "Trying…" : "Try again"}
        </button>
      </Alert>
    );
  }
  return <LoadError what="your customers" error={error} onRetry={onRetry} busy={busy} />;
}

/** "38 of the 50 customers shown have a phone number; 12 don't." and where to ask for one at checkout. */
function NumberSummary({ rows, shopAdminUrl }: { rows: WaShopifyCustomer[]; shopAdminUrl: string }) {
  const total = rows.length;
  const withNumber = rows.filter((r) => r.phone).length;
  const without = total - withNumber;
  const noCode = rows.filter((r) => r.phone && !r.phoneE164).length;
  const text =
    total === 1
      ? withNumber
        ? "This customer has a phone number."
        : "This customer has no phone number."
      : `${fmtNum(withNumber)} of the ${fmtNum(total)} customers shown ${withNumber === 1 ? "has" : "have"} a phone number${without ? `; ${fmtNum(without)} ${without === 1 ? "doesn't" : "don't"}` : ""}.`;
  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2 text-sm">
      <p>
        <span className="font-medium">{text}</span>
        {noCode > 0 && ` ${plural(noCode, "number")} ${noCode === 1 ? "has" : "have"} no country code, so WhatsApp can't use ${noCode === 1 ? "it" : "them"} as typed.`}
      </p>
      {without > 0 && (
        <p className="mt-0.5 text-xs text-muted">
          To get one from every new customer,{" "}
          <a className="underline" href={`${shopAdminUrl}/settings/checkout`} target="_blank" rel="noopener noreferrer">
            ask for a phone number at checkout
          </a>{" "}
          in Shopify.
        </p>
      )}
    </div>
  );
}

/** Two letters for the avatar from the name; "#" when there is none to show. */
function initials(name: string | null) {
  const words = (name ?? "").split(/[\s._-]+/).filter(Boolean);
  return words.length ? ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() : "#";
}

/** A steady colour per customer, so the same person always looks the same. */
function hue(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** A consent record (GET /contacts) as a row's WhatsApp state; a send doesn't change the do-not-message list, so that is kept. */
const whatsappOf = (c: WaContact, before: WaCustomerWhatsapp | null): WaCustomerWhatsapp => ({
  contactId: c.id,
  optedOut: c.optedOut,
  optedIn: c.optedIn,
  marketing: c.marketing,
  suppressed: before?.suppressed ?? null,
  notOnWhatsapp: c.notOnWhatsapp,
  lastOutboundAt: c.lastOutboundAt,
});

/** What WhatsApp knows of the number, as badges (nothing for a row without an international number). */
function whatsappBadges(r: WaShopifyCustomer): Array<{ tone: Tone; label: string }> {
  if (!r.phoneE164) return [];
  const w = r.whatsapp;
  if (!w) return [{ tone: "neutral", label: "New to WhatsApp" }];
  const out: Array<{ tone: Tone; label: string }> = [];
  if (w.optedOut) out.push({ tone: "danger", label: "Opted out" });
  if (w.suppressed === "all") out.push({ tone: "danger", label: "On the do-not-message list" });
  else if (w.suppressed === "marketing") out.push({ tone: "warn", label: "On the do-not-message list for marketing" });
  if (!w.optedOut && w.suppressed !== "all") {
    if (w.suppressed !== "marketing") out.push(MARKETING[w.marketing]);
    if (w.optedIn) out.push({ tone: "good", label: "Agreed to order updates" });
  }
  if (w.notOnWhatsapp) out.push({ tone: "neutral", label: "Not on WhatsApp" });
  return out;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition hover:border-accent hover:text-accent"
      title={label}
      aria-label={label}
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1500);
          },
          // Clipboard blocked: the number is on screen to select by hand.
          () => undefined,
        )
      }
    >
      {done ? <Check size={16} className="text-good" aria-hidden /> : <Copy size={16} aria-hidden />}
    </button>
  );
}

/** The whole number (a link to call it) with Copy, where Shopify had it, and how it was read. */
function PhoneNumber({ r }: { r: WaShopifyCustomer }) {
  if (!r.phone) return <p className="text-sm text-muted">No phone number on file</p>;
  const shownAs = r.phoneE164 ? formatPhone(r.phoneE164) : r.phone;
  const dial = r.phoneE164 ?? r.phone.replace(/[^\d+]/g, "");
  const typed = r.phoneE164 && r.phoneRaw && digitsOf(r.phoneRaw) !== digitsOf(r.phoneE164) ? r.phoneRaw : null;
  // Only a code the customer didn't type was added ("0412 345 678" read as Australian); "0044 …" or an extension is the same number typed another way.
  const added = typed && r.phoneE164 && !phoneCodeTyped(typed, r.phoneE164) ? (r.phoneCountryAssumed ? "your store's country" : "their address") : null;
  const notes = [
    r.phoneSource ? CUSTOMER_PHONE_SOURCE_LABEL[r.phoneSource] : null,
    typed ? `As typed: ${typed}${added ? ` (country code added from ${added})` : ""}` : null,
    r.smsSubscribed ? "Agreed to marketing texts in Shopify" : null,
  ].filter(Boolean);
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <a className="font-medium tabular-nums hover:text-accent hover:underline" href={`tel:${dial}`} title={`Call ${shownAs}`} data-testid="wa-customer-phone">
          {shownAs}
        </a>
        <CopyButton text={r.phoneE164 ?? r.phone} label={`Copy ${shownAs}`} />
      </div>
      {notes.length > 0 && <p className="text-xs text-muted">{notes.join(" · ")}</p>}
      {!r.phoneE164 && <p className="text-xs text-warn">No country code, so WhatsApp can&apos;t use this number as typed. Add the country code to it in Shopify.</p>}
    </div>
  );
}

function CustomerRow({ r, showOrders, manage, canSend, onMessage }: { r: WaShopifyCustomer; showOrders: boolean; manage: boolean; canSend: boolean; onMessage: () => void }) {
  const name = r.name ?? `Customer #${r.customerId}`;
  const w = r.whatsapp;
  const badges = whatsappBadges(r);
  // Only to a number WhatsApp can use, that didn't ask not to be messaged (the send checks consent again).
  const messageable = !!r.phoneE164 && !w?.optedOut && w?.suppressed !== "all" && !w?.notOnWhatsapp;
  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start" data-testid="wa-customer">
      <div className="flex min-w-0 flex-1 gap-3">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: `hsl(${hue(r.customerId)} 45% 45%)` }}>
          {initials(r.name)}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex flex-wrap items-baseline gap-x-2">
            {r.adminUrl ? (
              <a className="font-medium hover:text-accent hover:underline" href={r.adminUrl} target="_blank" rel="noopener noreferrer" title="Open in Shopify">
                {name}
              </a>
            ) : (
              <span className="font-medium">{name}</span>
            )}
            {showOrders && r.orders != null && (
              <span className="text-xs text-muted">
                {plural(r.orders, "order")} · {fmtMoney(r.spent ?? 0, r.currency ?? undefined)} spent
              </span>
            )}
          </p>
          <PhoneNumber r={r} />
          {(badges.length > 0 || w?.lastOutboundAt) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {badges.map((b) => (
                <Badge key={b.label} tone={b.tone}>
                  {b.label}
                </Badge>
              ))}
              {w?.lastOutboundAt && <span className="text-xs text-muted">Last WhatsApp message {fmtAgo(w.lastOutboundAt)}</span>}
            </div>
          )}
        </div>
      </div>
      {manage && messageable && (
        <button type="button" className="btn-secondary shrink-0 self-start" onClick={onMessage} disabled={!canSend} title={canSend ? undefined : "Connect WhatsApp first"}>
          <Send size={16} aria-hidden /> Message
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Consent records (what WhatsApp keeps)
// ---------------------------------------------------------------------------

function ConsentRecords({ base, overview }: { base: string; overview: WaOverview }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [consent, setConsent] = useState<"" | "opted_in" | "opted_out" | "unknown">("");
  const [recording, setRecording] = useState(false);
  const manage = overview.can.manage;
  const path = `${base}/contacts${consent ? `?consent=${consent}` : ""}`;

  return (
    <div className="space-y-4">
      <div className="card animate-rise space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Customers and consent</h2>
            <p className="mt-1 text-sm text-muted">
              Order updates go out under your choice in Settings (now: {WA_ORDER_UPDATE_INFO[overview.settings.orderUpdates].label.toLowerCase()}); marketing only to customers who agreed to it. A customer who
              replies STOP gets nothing more until they reply START. Only messages from your store&apos;s customers are recorded: the rest of the phone&apos;s chats are never read.
            </p>
          </div>
          {manage && (
            <button type="button" className="btn-primary" onClick={() => setRecording(true)}>
              Record consent
            </button>
          )}
        </div>
        <SearchForm id={`${id}-phone`} label="Find a number" placeholder="+61 412 345 678" inputMode="tel" onSearch={setSearch} onClear={() => setConsent("")} active={!!(search || consent)}>
          <div>
            <label className="label" htmlFor={`${id}-consent`}>
              Marketing consent
            </label>
            <select id={`${id}-consent`} className="input" value={consent} onChange={(e) => setConsent(e.target.value as typeof consent)}>
              <option value="">Everyone</option>
              <option value="opted_in">Agreed to marketing</option>
              <option value="unknown">Not asked</option>
              <option value="opted_out">Opted out</option>
            </select>
          </div>
        </SearchForm>
      </div>
      <ContactList path={path} search={search} filtered={!!(search || consent)} />
      {recording && <RecordConsentDialog base={base} onClose={() => setRecording(false)} />}
    </div>
  );
}

function ContactList({ path, search, filtered }: { path: string; search: string; filtered: boolean }) {
  const { pages, cursor, loading, error, loadMore, reload } = usePages<{ contacts: WaContact[]; nextCursor: string | null }>(path, search);
  if (error) return <LoadError what="the customers" error={error} onRetry={() => void reload()} busy={loading} />;
  if (!pages) return <Skeleton lines={4} />;
  const rows = pages.flatMap((p) => p.contacts);
  if (!rows.length)
    return (
      <div className="card">
        <Empty>{filtered ? "No customer matches. Search with the full number, including its country code." : "No consent records yet: a customer appears here once a message is sent to them, they write to you, or their consent is recorded."}</Empty>
      </div>
    );
  return (
    <div className="card animate-rise space-y-3">
      <ul className="divide-y divide-border">
        {rows.map((c) => {
          // The masked form only when the number couldn't be read (the API says so by sending it as is).
          const whole = c.phone !== c.phoneMasked;
          const shownAs = whole ? formatPhone(c.phone) : c.phone;
          return (
            <li key={c.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium tabular-nums">{shownAs}</span>
                    {whole && <CopyButton text={c.phone} label={`Copy ${shownAs}`} />}
                    {c.firstName && <span className="text-muted">{c.firstName}</span>}
                  </div>
                  <p className="text-xs text-muted">
                    {c.country ? countryName(c.country) : "Country unknown"}
                    {/* The order count only with "View order history" (null without it). */}
                    {c.ordersCount != null && ` · ${plural(c.ordersCount, "order")}`} · last message from them {fmtAgo(c.lastInboundAt)} · last sent {fmtAgo(c.lastOutboundAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {c.optedOut ? <Badge tone="danger">Opted out of everything</Badge> : <Badge tone={MARKETING[c.marketing].tone}>{MARKETING[c.marketing].label}</Badge>}
                  {!c.optedOut && c.optedIn && <Badge tone="good">Agreed to order updates</Badge>}
                  {c.notOnWhatsapp && <Badge tone="neutral">Not on WhatsApp</Badge>}
                </div>
              </div>
              {c.history.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted hover:text-text">Consent history</summary>
                  <ol className="mt-2 space-y-1 border-l border-border pl-3">
                    {c.history.map((h, i) => (
                      <li key={i}>
                        <span className="font-medium">
                          {SCOPE_LABEL[h.scope] ?? h.scope}: {h.status === "opted_in" ? "agreed" : "opted out"}
                        </span>{" "}
                        <span className="text-muted">
                          · {h.sourceLabel} · {fmtAgo(h.at)}
                        </span>
                        {h.note && <span className="block text-muted">“{h.note}”</span>}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          );
        })}
      </ul>
      {cursor && (
        <button type="button" className="btn-secondary w-full" onClick={loadMore} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}

function CountrySelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">The number includes its country code (+…)</option>
      {COUNTRY_CHOICES.map((c) => (
        <option key={c} value={c}>
          {countryName(c)}
        </option>
      ))}
    </select>
  );
}

function RecordConsentDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const id = useId();
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [scope, setScope] = useState<"all" | "order_updates" | "marketing">("marketing");
  const [status, setStatus] = useState<"opted_in" | "opted_out">("opted_in");
  const [note, setNote] = useState("");
  return (
    <Dialog open title="Record consent" onClose={onClose}>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || phone.trim().length < 6) return;
          void run("consent", "record the consent", async () => {
            await api(`${base}/contacts/consent`, { method: "POST", body: { phone: phone.trim(), country: country || null, scope, status, note: note.trim() || null } });
            onClose();
            return status === "opted_in" ? "Recorded: the customer agreed." : "Recorded: the customer opted out. Messages waiting for them are not sent.";
          });
        }}
      >
        <p className="text-sm text-muted">For consent given some other way: in your store, by email, on a form. It is recorded with your name and the note.</p>
        <div>
          <label className="label" htmlFor={`${id}-phone`}>
            Customer&apos;s WhatsApp number
          </label>
          <input id={`${id}-phone`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-country`}>
            Country (for a number without +)
          </label>
          <CountrySelect id={`${id}-country`} value={country} onChange={setCountry} />
        </div>
        <fieldset>
          <legend className="label">For</legend>
          <div className="space-y-1 text-sm">
            {(["marketing", "order_updates", "all"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input type="radio" name={`${id}-scope`} className="accent-[var(--accent)]" checked={scope === s} onChange={() => setScope(s)} />
                {s === "all" ? "Every message from the store" : s === "order_updates" ? "Order updates" : "Marketing messages"}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="label">The customer</legend>
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-status`} className="accent-[var(--accent)]" checked={status === "opted_in"} onChange={() => setStatus("opted_in")} />
              Agreed to receive them
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={`${id}-status`} className="accent-[var(--accent)]" checked={status === "opted_out"} onChange={() => setStatus("opted_out")} />
              Asked not to receive them
            </label>
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor={`${id}-note`}>
            Note (optional)
          </label>
          <input id={`${id}-note`} className="input" maxLength={300} placeholder="Signed up at the counter on 22 Oct" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!!busy || phone.trim().length < 6}>
            {busy ? "Recording…" : "Record consent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function DoNotMessage({ base, manage }: { base: string; manage: boolean }) {
  const list = useApi<{ suppressions: WaSuppression[] }>(`${base}/suppressions`);
  const { busy, run } = useWaAction();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<WaSuppression | null>(null);
  return (
    <div className="card animate-rise space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Do not message</h2>
          <p className="mt-1 text-sm text-muted">Numbers your store never messages, or never sends marketing to. Customers who replied STOP are here until they reply START.</p>
        </div>
        {manage && (
          <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
            Add a number
          </button>
        )}
      </div>
      {list.error ? (
        <LoadError what="the do-not-message list" error={list.error} onRetry={() => void list.reload()} busy={list.loading} />
      ) : !list.data ? (
        <div className="skeleton h-16" />
      ) : !list.data.suppressions.length ? (
        <Empty>Nobody is on the list.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.data.suppressions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{s.phone}</p>
                <p className="text-xs text-muted">
                  {SUPPRESSION_SCOPE[s.scope] ?? s.scope} · {SUPPRESSION_REASON[s.reason] ?? s.reason.replace(/_/g, " ")} · {fmtAgo(s.createdAt)}
                  {s.note ? ` · “${s.note}”` : ""}
                </p>
              </div>
              {manage && (
                <button type="button" className="btn-secondary h-8 px-3 text-xs" onClick={() => setRemoving(s)} disabled={!!busy}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <AddSuppressionDialog base={base} onClose={(done) => {
            setAdding(false);
            if (done) void list.reload();
          }} />}
      <ConfirmDialog
        open={!!removing}
        title={removing ? `Take ${removing.phone} off the list?` : ""}
        confirmLabel="Remove"
        busy={busy === "remove"}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          void run("remove", "remove the number from the list", async () => {
            await api(`${base}/suppressions/${removing!.id}`, { method: "DELETE" });
            setRemoving(null);
            void list.reload();
            return "Removed from the list.";
          }).then((ok) => {
            if (!ok) setRemoving(null);
          })
        }
      >
        <p>Messages can go to this number again, under the store&apos;s consent rules. A customer who replied STOP can only be taken off by replying START.</p>
      </ConfirmDialog>
    </div>
  );
}

function AddSuppressionDialog({ base, onClose }: { base: string; onClose: (done: boolean) => void }) {
  const id = useId();
  const { busy, run } = useWaAction();
  const [phone, setPhone] = useState("");
  const [country, setCountry] = useState("");
  const [scope, setScope] = useState<"all" | "marketing">("all");
  const [note, setNote] = useState("");
  return (
    <Dialog open title="Add to Do not message" onClose={() => onClose(false)}>
      <form
        noValidate
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || phone.trim().length < 6) return;
          void run("add", "add the number", async () => {
            await api(`${base}/suppressions`, { method: "POST", body: { phone: phone.trim(), country: country || null, scope, note: note.trim() || null } });
            onClose(true);
            return "Added. Messages waiting for this number are not sent.";
          });
        }}
      >
        <div>
          <label className="label" htmlFor={`${id}-phone`}>
            WhatsApp number
          </label>
          <input id={`${id}-phone`} className="input" inputMode="tel" placeholder="+61 412 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor={`${id}-country`}>
            Country (for a number without +)
          </label>
          <CountrySelect id={`${id}-country`} value={country} onChange={setCountry} />
        </div>
        <fieldset>
          <legend className="label">Never send</legend>
          <div className="space-y-1 text-sm">
            {(["all", "marketing"] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input type="radio" name={`${id}-scope`} className="accent-[var(--accent)]" checked={scope === s} onChange={() => setScope(s)} />
                {s === "all" ? "Any message, order updates included" : "Marketing messages"}
              </label>
            ))}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor={`${id}-note`}>
            Note (optional)
          </label>
          <input id={`${id}-note`} className="input" maxLength={300} placeholder="Asked by phone" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={() => onClose(false)} disabled={!!busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!!busy || phone.trim().length < 6}>
            {busy ? "Adding…" : "Add to the list"}
          </button>
        </div>
      </form>
      <p className="mt-3 text-xs text-muted">
        To see what was sent to a number, search for it in <Link className="underline" href={waHref("messages")}>Messages</Link>.
      </p>
    </Dialog>
  );
}
