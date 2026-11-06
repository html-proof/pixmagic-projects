"use client";
import type { ReactNode } from "react";
import { Mail, MessageSquareText } from "lucide-react";
import type { IntegrationModule, IntegrationStatus } from "@app/shared/integrations";
import { useApp, type StoreSummary } from "@/components/AppContext";
import { canOpenPage } from "@/lib/access";
import { friendlyError, useApi } from "@/lib/api";
import { ConnectButton, IntegrationRow, ManageLink, RowPill, STATUS_TONE } from "./IntegrationRow";

// ---------------------------------------------------------------------------
// Settings → Integrations' SMS and Email cards (the Stitch design's screen 30). Each is told how it
// stands by GET …/integrations (core's integrations/status.ts): the one scale of six statuses every
// page shares, worked out on the server from the Automations hub's cards, and what this member may
// do there. Nothing is decided here: the card words that status, names the sender or mailbox when
// the answer gives one (only to whoever may open the channel's own page), and offers the channel's
// own page, where texting and email are set up and looked after.
// ---------------------------------------------------------------------------

export type IntegrationsAnswer = { modules: IntegrationModule[] };

/** Where every connection of the store stands (the API's answer, for the cards told on its scale). */
export function useIntegrations(storeBase: string | null) {
  return useApi<IntegrationsAnswer>(storeBase ? `${storeBase}/integrations` : null);
}

type Channel = "sms" | "email";

/** Each status's words on these cards. */
export const STATUS_LABEL: Record<IntegrationStatus, string> = {
  connected: "Connected",
  pending: "Setup to finish",
  reauthorization_required: "Sign in again",
  syncing: "Checking",
  error: "Not working",
  disconnected: "Not connected",
};

/** A status that waits on someone: the card's button goes to where it's fixed. */
const ATTENTION: ReadonlySet<IntegrationStatus> = new Set(["pending", "reauthorization_required", "error"]);

const INFO: Record<Channel, { name: string; sub: string; brings: string[]; home: string; noStore: string; icon: ReactNode }> = {
  sms: {
    name: "SMS",
    sub: "Texts to your customers' mobiles. bizinsights sends them: you need no AWS account and give no keys.",
    brings: ["Order updates", "Campaigns", "Automations"],
    home: "/messaging",
    noStore: "Connect your Shopify store first: texts are about its orders.",
    icon: <MessageSquareText size={18} strokeWidth={2} className="text-accent" />,
  },
  email: {
    name: "Email",
    sub: "Email from your own address, sent through the mailbox you connect.",
    brings: ["Automations", "Message history"],
    home: "/settings/email",
    noStore: "Connect your Shopify store first: emails go out about its orders.",
    icon: <Mail size={18} strokeWidth={2} className="text-accent" />,
  },
};

/** "hello@shop.com", "hello@shop.com +1 more": the accounts the answer names (none for a member who may not open the channel's page). */
function accountsLine(m: IntegrationModule): string | null {
  const named = m.accounts.filter((a) => a.name);
  if (!named.length) return null;
  return `${named[0]!.name}${named.length > 1 ? ` +${named.length - 1} more` : ""}`;
}

/** How the channel stands, in a sentence. */
function standing(ch: Channel, m: IntegrationModule): string {
  switch (m.status) {
    case "connected":
      return ch === "sms" ? "Ready to send." : "Sending from your own address.";
    case "pending":
      return ch === "sms" ? "A step of the setup is left before texts can go." : "A step is left before email can go, such as verifying the sender.";
    case "reauthorization_required":
      return ch === "sms" ? "Someone needs to connect it again." : "A mailbox needs signing in to again.";
    case "syncing":
      return "Being checked now.";
    case "error":
      if (ch === "email" && m.code === "suspended") return "bizinsights has suspended sending for this workspace.";
      return ch === "sms" ? "The last check of the sender didn't work." : "A mailbox isn't sending.";
    default:
      if (m.code === "not_configured") return `${INFO[ch].name} isn't switched on for bizinsights yet.`;
      return "Nothing connected yet.";
  }
}

function ChannelCard({ ch, store, answer, error }: { ch: Channel; store: StoreSummary | null; answer: IntegrationsAnswer | null; error: unknown }) {
  const { access, workspace, me, offers } = useApp();
  const I = INFO[ch];
  const m = answer?.modules.find((x) => x.id === ch) ?? null;
  // The channel's own page, where it is set up and looked after, when this member may open it (Team & Access).
  const mayOpen = canOpenPage(I.home, access, workspace.staffRole ?? null, !!me.shared, offers);

  const pill = !store ? (
    <RowPill label="Not connected" tone="neutral" state="not_connected" />
  ) : !m ? (
    error ? <RowPill label="Status unavailable" tone="neutral" state="unknown" /> : <RowPill label="Checking…" tone="neutral" busy state="checking" />
  ) : (
    <RowPill label={STATUS_LABEL[m.status]} tone={STATUS_TONE[m.status]} busy={m.status === "syncing"} state={m.status} />
  );

  const action =
    !store || !m || !mayOpen ? null : m.status === "disconnected" ? (
      m.actions.includes("connect") && m.code !== "not_configured" ? <ConnectButton name={I.name} href={I.home} testid={`int-${ch}-connect`} /> : null
    ) : (
      <ManageLink name={I.name} href={I.home} attention={ATTENTION.has(m.status)} />
    );

  const accounts = m ? accountsLine(m) : null;
  return (
    <IntegrationRow
      testid={`int-${ch}`}
      state={!store ? "not_connected" : (m?.status ?? (error ? "unknown" : "checking"))}
      status={!store ? "disconnected" : m?.status}
      logo={I.icon}
      name={I.name}
      sub={I.sub}
      pill={pill}
      action={action}
      brings={I.brings}
    >
      {!store ? (
        <p className="text-muted">{I.noStore}</p>
      ) : !m ? (
        error ? (
          <p className="text-muted">
            We couldn&apos;t check {I.name} just now. {friendlyError(error)}
          </p>
        ) : null
      ) : (
        <p data-testid={`int-${ch}-standing`}>
          {accounts && (
            <>
              <span className="text-muted">{ch === "sms" ? "Sender:" : m.accounts.length > 1 ? "Mailboxes:" : "Mailbox:"}</span> {accounts}
              <span className="text-muted"> · </span>
            </>
          )}
          <span className="text-muted">{standing(ch, m)}</span>
        </p>
      )}
    </IntegrationRow>
  );
}

/** The SMS and Email cards, each where the workspace offers it. */
export function ChannelCards({ store, sms, email, answer, error }: { store: StoreSummary | null; sms: boolean; email: boolean; answer: IntegrationsAnswer | null; error: unknown }) {
  return (
    <>
      {sms && <ChannelCard ch="sms" store={store} answer={answer} error={error} />}
      {email && <ChannelCard ch="email" store={store} answer={answer} error={error} />}
    </>
  );
}
