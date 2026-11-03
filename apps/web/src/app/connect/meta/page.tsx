"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { AD_PLATFORMS } from "@/components/integrations/adPlatforms";
import { AccountPicker } from "@/components/settings/ads/ChooseAccounts";
import { callbackErrorMessage } from "@/components/settings/ads/callbackErrors";
import { Alert, AuthShell } from "@/components/ui";
import type { PendingAccounts } from "@/lib/adConnections";
import { leavingForSignIn, signInFinished, useBackFromSignIn } from "@/lib/adSignIn";
import { actionError, api } from "@/lib/api";

/** The link as POST /ads/links/open answers it (apps/api/src/routes/adLinks.ts). */
interface LinkInfo {
  provider: "meta";
  workspace: string;
  store: string;
  expiresAt: string;
  state: "open" | "used" | "ended";
  /** How many ad accounts the link connected, once used. */
  accounts: number | null;
  configured: boolean;
  choice: PendingAccounts | null;
}

/** The API's codes for this page, in its words (a public call's errors are otherwise worded generically). */
const MESSAGES: Record<string, string> = {
  link_invalid: "This link isn't valid any more: it has ended, or it was turned off. Ask whoever sent it for a new one.",
  link_used: "This link has been used already. Ask whoever sent it for a new one if more ad accounts need connecting.",
  link_ended: "This link no longer works. Ask whoever sent it for a new one.",
  pending_expired: "That took a little too long, so nothing was connected. Press Continue with Meta Ads to sign in again.",
  invalid_accounts: "Choose from the accounts listed.",
  not_configured: "Meta Ads isn't set up for bizinsights right now, so there's nothing to connect to. It's on our side, not yours: please try again later.",
  rate_limited: "That's a lot of tries in a short time. Wait a few minutes, then try again.",
};

/** What the callback means when it sends the browser back here with `?error=`: the link's own codes, then the sign-in's. */
const backError = (code: string) => MESSAGES[code] ?? callbackErrorMessage(code, "meta");

/** Only ever a nonce the callback put there: it goes into a request body. */
const isPick = (v: string | null): v is string => !!v && /^[A-Za-z0-9_-]{16,64}$/.test(v);

/**
 * A connect link's page (/connect/meta?t=…), for whoever runs a store's Facebook ads: someone who
 * manages the store's integrations made the link on Settings → Advertising and sent it to them. They
 * need no bizinsights login. The page says which store the link is for, sends them to Facebook's own
 * sign-in for bizinsights' Meta app (read-only, ads_read), and after Facebook lets them tick the ad
 * accounts that belong to the store. The callback (apps/api/src/routes/ads.ts finishLinkSignIn) sends
 * the browser back here with `choose`, `done` or `error`.
 */
function ConnectMeta() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  const P = AD_PLATFORMS.meta;
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    async (withPick: string | null) => {
      try {
        const r = await api<LinkInfo>("/ads/links/open", { method: "POST", body: { token, ...(withPick ? { pick: withPick } : {}) }, credentials: "omit", referrerPolicy: "no-referrer" });
        setInfo(r);
        setLoadError(null);
      } catch (e) {
        setLoadError(actionError(e, "open this link", MESSAGES));
      }
    },
    [token],
  );

  // Coming back from Facebook: accounts to choose, accounts connected, or what went wrong. Read once,
  // then taken out of the address so a reload doesn't say it again.
  useEffect(() => {
    if (!token) return;
    const q = new URLSearchParams(window.location.search);
    const code = q.get("error");
    const choose = q.get("choose");
    const connected = q.get("done");
    if (code) setError(backError(code));
    if (isPick(choose)) setPick(choose);
    if (connected && /^\d{1,5}$/.test(connected)) setDone(Number(connected));
    if (code || choose || connected) {
      signInFinished();
      window.history.replaceState(window.history.state, "", `/connect/meta?${new URLSearchParams({ t: token })}`);
    }
    void open(isPick(choose) ? choose : null);
  }, [token, open]);

  // Back from Facebook without finishing: the button isn't left on "Opening Meta…".
  useBackFromSignIn(() => setBusy(false));

  const start = async () => {
    setBusy(true);
    setError(null);
    setCancelled(false);
    try {
      // The sign-in's state cookie is set by this answer, so this one call keeps the browser's cookies.
      const { url } = await api<{ url: string }>("/ads/links/start", { method: "POST", body: { token }, referrerPolicy: "no-referrer" });
      leavingForSignIn("meta");
      window.location.assign(url);
    } catch (e) {
      setError(actionError(e, "open Facebook's sign-in", MESSAGES));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthShell title="Connect Meta ads">
        <Alert>This link is incomplete. Copy the whole link from the message it came in, or ask whoever sent it for a new one.</Alert>
      </AuthShell>
    );
  }
  if (loadError && !info) {
    return (
      <AuthShell title="Connect Meta ads">
        <Alert>{loadError}</Alert>
      </AuthShell>
    );
  }
  if (!info) {
    return (
      <AuthShell title="Connect Meta ads">
        <div className="skeleton h-40" aria-busy="true" aria-label="Opening the link" />
      </AuthShell>
    );
  }

  const subtitle = `For ${info.store}, in ${info.workspace}'s bizinsights`;
  const connectedCount = done ?? info.accounts;
  if (done !== null || info.state === "used") {
    return (
      <AuthShell title="Meta ads connected" subtitle={subtitle}>
        <Alert kind="success">
          <span data-testid="link-done">
            {connectedCount !== null ? `${connectedCount} ad account${connectedCount === 1 ? " is" : "s are"} connected to ${info.store}.` : `This link has connected ad accounts to ${info.store} already.`} Their figures come
            in by themselves over the next minutes; you can close this page. The link is used up now.
          </span>
        </Alert>
        <p className="text-sm text-muted">
          To stop bizinsights reading them, remove bizinsights in Facebook&apos;s Settings → Business integrations, or ask the store to disconnect them.
        </p>
      </AuthShell>
    );
  }
  if (info.state === "ended") {
    return (
      <AuthShell title="Connect Meta ads" subtitle={subtitle}>
        <Alert>{MESSAGES.link_ended}</Alert>
      </AuthShell>
    );
  }

  if (pick && info.choice) {
    return (
      <AuthShell title="Choose the ad accounts" subtitle={subtitle}>
        <AccountPicker
          data={info.choice}
          storeName={info.store}
          intro={`Tick the ones whose ads belong to ${info.store}. Only those are connected, and only their figures are read.`}
          messages={MESSAGES}
          onConfirm={async (accountIds) => {
            const r = await api<{ connected: number }>("/ads/links/choose", { method: "POST", body: { token, pick, accountIds }, credentials: "omit", referrerPolicy: "no-referrer" });
            setPick(null);
            setDone(r.connected);
          }}
          onCancel={async () => {
            await api("/ads/links/cancel", { method: "POST", body: { token, pick }, credentials: "omit", referrerPolicy: "no-referrer" }).catch(() => undefined);
            setPick(null);
            setCancelled(true);
          }}
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Connect Meta ads" subtitle={subtitle}>
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
      {pick && !info.choice && !error && <Alert>{MESSAGES.pending_expired}</Alert>}
      {cancelled && <Alert kind="info">Nothing was connected. You can sign in again while the link lasts.</Alert>}
      <p className="text-sm">
        <strong>{info.workspace}</strong> asks you to connect the Meta ad accounts that run ads for <strong>{info.store}</strong>, so their figures show on its bizinsights
        dashboard. You don&apos;t need a bizinsights account.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
        <li>You sign in on Facebook&apos;s own page and choose which ad accounts to share; your password never reaches bizinsights.</li>
        <li>bizinsights reads spend, impressions, clicks and conversions for each campaign and day. Nothing is ever changed in your ad accounts.</li>
        <li>The store sees those figures until you or they disconnect.</li>
      </ul>
      {info.configured ? (
        <button type="button" className="btn-primary w-full" onClick={() => void start()} disabled={busy} data-testid="link-continue">
          {busy ? (
            P.opening
          ) : (
            <>
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-white" aria-hidden>
                <P.Icon size={12} />
              </span>
              {P.button}
            </>
          )}
        </button>
      ) : (
        <Alert>{MESSAGES.not_configured}</Alert>
      )}
      <p className="text-xs text-muted">This link works once, until {new Date(info.expiresAt).toLocaleDateString(undefined, { dateStyle: "medium" })}.</p>
    </AuthShell>
  );
}

export default function ConnectMetaPage() {
  return (
    <Suspense fallback={<AuthShell title="Connect Meta ads">Loading…</AuthShell>}>
      <ConnectMeta />
    </Suspense>
  );
}
