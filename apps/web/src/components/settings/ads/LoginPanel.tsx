"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, CircleCheck, RefreshCw } from "lucide-react";
import { fmtRelative } from "@/components/dashboard/format";
import type { AdPlatformInfo } from "@/components/integrations/adPlatforms";
import type { AdLogin } from "@/lib/adConnections";
import { PanelTitle, Rows, STATE_COLOR, tone } from "./ui";

/** Where each platform's sign-in is made, as the person saw it. */
const SIGNED_IN_AT: Record<string, string> = { meta: "Facebook", google: "Google", adsense: "Google" };

/** "Your Facebook login": the sign-in a waiting login was made with. */
export const loginOfPlatform = (l: Pick<AdLogin, "provider">) => `${SIGNED_IN_AT[l.provider] ?? "platform"} login`;

/**
 * What a sign-in connected with no ad account yet says, by why (AD_LOGIN_REASONS). Never an error: the
 * person connected, and the ad accounts follow by themselves once the platform lists them.
 */
export function loginWords(l: Pick<AdLogin, "provider" | "reason">): { accounts: string; short: string; text: string } {
  const login = `Your ${loginOfPlatform(l)}`;
  const at = SIGNED_IN_AT[l.provider] ?? "the platform";
  switch (l.reason) {
    case "none_shared":
      return {
        accounts: "None shared yet",
        short: "no ad account shared yet",
        text: `${login} is connected. No ad account was shared with bizinsights on ${at}'s screen yet: Choose ad accounts opens it again, to tick the ones this store's ads run from.`,
      };
    case "unanswered":
      return { accounts: "Being fetched", short: "its ad accounts are being fetched", text: `${login} is connected. ${at} was slow to list its ad accounts, so bizinsights fetches them by itself in a few minutes.` };
    case "choose":
      return { accounts: "Several to choose from", short: "several ad accounts to choose from", text: `${login} is connected and reaches several ad accounts now. Choose ad accounts to pick the ones for this store.` };
    default:
      return {
        accounts: "None yet",
        short: "no ad account yet; added by itself once one appears",
        text: `${login} is connected. It doesn't reach an ad account yet, so there are no figures to show. bizinsights looks every hour and adds your ad accounts by itself as soon as ${at} lists one.`,
      };
  }
}

/** What the page says right after such a sign-in: connected, and what comes next. */
export function loginConnectedNote(name: string, l: Pick<AdLogin, "provider" | "reason">): string {
  const at = SIGNED_IN_AT[l.provider] ?? "the platform";
  if (l.reason === "none_shared" || l.reason === "choose") return `${name} is connected. Press Choose ad accounts to pick the ones for this store.`;
  return `${name} is connected. Its ad accounts appear here by themselves as soon as ${at} lists them.`;
}

/**
 * Settings → Advertising, a platform whose sign-in is connected with no ad account yet: who is
 * connected (Login details) beside how it stands (Connected, and what happens next), with Check for ad
 * accounts and Choose ad accounts (the platform's screen again) under them.
 */
export function LoginPanel({
  login,
  P,
  testid,
  canAct,
  busy,
  checking,
  leaving,
  dashboard,
  onCheck,
  onChoose,
}: {
  login: AdLogin;
  P: AdPlatformInfo;
  testid: string;
  canAct: boolean;
  busy: boolean;
  /** Check for ad accounts is running. */
  checking: boolean;
  /** The platform's sign-in is being opened. */
  leaving: boolean;
  /** The member may open the platform's Advertising page. */
  dashboard: boolean;
  onCheck: () => void;
  onChoose: () => void;
}) {
  const words = loginWords(login);
  const by = login.connectedBy ? (login.connectedBy.you ? "You" : (login.connectedBy.name ?? login.connectedBy.email ?? "A member of this workspace")) : null;
  const rows: Array<[string, ReactNode]> = [
    ["Signed in as", login.name ?? `Your ${loginOfPlatform(login)}`],
    ["Ad accounts", words.accounts],
    ["Connected", <span key="at" title={new Date(login.connectedAt).toLocaleString()}>{fmtRelative(login.connectedAt)}</span>],
    ...(by ? [["Connected by", by] as [string, ReactNode]] : []),
    ["Last checked", <span key="checked" title={new Date(login.checkedAt).toLocaleString()}>{fmtRelative(login.checkedAt)}</span>],
  ];
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]" data-testid={`${testid}-login`} data-reason={login.reason}>
        <section className="min-w-0 rounded-xl border border-border bg-bg/40 p-4" aria-labelledby={`${testid}-login-h`}>
          <PanelTitle id={`${testid}-login-h`}>Login details</PanelTitle>
          <Rows rows={rows} />
        </section>
        <section aria-labelledby={`${testid}-status`} className="tone-card flex flex-col gap-4 rounded-xl border p-4" style={tone(STATE_COLOR.good)}>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--tone)] text-[var(--surface)]" aria-hidden>
              <CircleCheck size={18} strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <PanelTitle id={`${testid}-status`}>Connected</PanelTitle>
              <p className="mt-1 text-sm text-muted" data-testid={`${testid}-login-text`}>
                {words.text}
              </p>
            </div>
          </div>
          {dashboard && (
            <Link className="btn-secondary mt-auto w-full" href={P.page}>
              View {P.name} dashboard
              <ArrowRight size={15} aria-hidden />
            </Link>
          )}
        </section>
      </div>
      {canAct && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="tone-solid" style={tone("var(--good)")} onClick={onCheck} disabled={busy} data-testid={`${testid}-login-check`}>
            <RefreshCw size={15} aria-hidden className={checking ? "motion-safe:animate-spin" : undefined} />
            {checking ? "Checking…" : "Check for ad accounts"}
          </button>
          <button type="button" className={login.reason === "choose" || login.reason === "none_shared" ? "btn-primary" : "btn-secondary"} onClick={onChoose} disabled={busy} data-testid={`${testid}-login-choose`}>
            {leaving ? P.opening : "Choose ad accounts"}
          </button>
        </div>
      )}
    </>
  );
}

