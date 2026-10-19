"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/AppUi";
import { GoogleIcon } from "@/components/BrandIcons";
import { PasswordField } from "@/components/auth/PasswordField";
import { useApi } from "@/lib/api";
import { authConfig, authErrorMessage, errorCode, linkErrorMessage, linkGoogle, linkNeedsPassword, prepareGoogleLink, type AccountInfo } from "@/lib/auth";
import { NoteAlert, type Note } from "./AdUi";
import { Facts, IntegrationCard, StatusBadge } from "./IntegrationCard";

/** Where linking Google comes back to: this page, with ?linked=google or ?link_error=<code>. */
const RETURN = "/settings/integrations";

const when = (t: string | null) => (t ? new Date(t).toLocaleDateString() : "never");

/**
 * "Google Account" on Connect your business: signing in to bizinsights with Google (through the
 * user pool), linked to this account from here. Shown only while the deployment offers Google
 * sign-in (GET /api/auth/config); otherwise nothing, since there is nothing to do. Settings →
 * Security (components/auth/AccountSecurity.tsx) is where sign-in methods are removed.
 */
export function GoogleAccountCard() {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<Note | null>(null);
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const account = useApi<AccountInfo>(offered ? "/auth/account" : null);
  const a = account.data;

  useEffect(() => {
    let live = true;
    authConfig()
      .then((c) => live && setOffered(c.providers.google))
      // Can't tell: no card, rather than one that may offer what isn't there.
      .catch(() => live && setOffered(false));
    return () => {
      live = false;
    };
  }, []);

  // Back from linking: say how it went, once, and take the answer out of the address.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const linked = q.get("linked");
    const linkError = q.get("link_error");
    if (!linked && !linkError) return;
    setMsg(
      linked === "google"
        ? { kind: "success", text: "Google is linked. You can now sign in to bizinsights with it too." }
        : { kind: linkError === "cancelled" ? "info" : "error", text: linkErrorMessage(linkError ?? "") },
    );
    q.delete("linked");
    q.delete("link_error");
    const rest = q.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);

  const cancel = useCallback(() => {
    setAsking(false);
    setPassword("");
  }, []);

  const alert = msg && <NoteAlert note={msg} onDismiss={() => setMsg(null)} />;
  if (!offered) return alert || null;

  const google = a?.methods.filter((m) => m.method === "google") ?? [];
  const state = !a ? (account.error ? "unknown" : "checking") : google.length ? "linked" : "not_linked";
  const badge =
    state === "checking" ? (
      <StatusBadge label="Checking…" tone="neutral" busy state={state} />
    ) : state === "unknown" ? (
      <StatusBadge label="Status unavailable" tone="neutral" state={state} />
    ) : state === "linked" ? (
      <StatusBadge label="Linked" tone="good" state={state} />
    ) : (
      <StatusBadge label="Not linked" tone="neutral" state={state} />
    );

  const start = () => {
    if (!a) return;
    setMsg(null);
    // Linking adds a way into the account: after the first 15 minutes of a sign-in, the password first.
    if (linkNeedsPassword(a) && a.signedInWith === "password") return setAsking(true);
    setLeaving(true);
    linkGoogle(RETURN);
  };

  const continueWithPassword = async () => {
    if (!password) return;
    setBusy(true);
    try {
      await prepareGoogleLink(password);
      setLeaving(true);
      linkGoogle(RETURN);
    } catch (err) {
      setMsg({ kind: errorCode(err) === "reauth_required" ? "info" : "error", text: authErrorMessage(err) });
      setBusy(false);
    } finally {
      cancel();
    }
  };

  return (
    <>
      {alert}
      <IntegrationCard
        testid="int-google-account"
        state={state}
        icon={<GoogleIcon size={22} />}
        name="Google Account"
        sub="Secure account authentication: sign in to bizinsights with Google"
        badge={badge}
        actions={
          <>
            {a?.canLinkGoogle && (
              <button type="button" className="btn-primary" onClick={start} disabled={leaving || busy} data-testid="int-google-account-link">
                <GoogleIcon size={16} /> {leaving ? "Opening Google…" : "Continue with Google"}
              </button>
            )}
            <Link className="btn-secondary" href="/settings/security">
              Manage sign-in methods
            </Link>
          </>
        }
      >
        {!a ? (
          account.error ? (
            <p className="text-muted">We couldn&apos;t check how you sign in just now. Please try again in a moment.</p>
          ) : null
        ) : google.length ? (
          <>
            <Facts
              rows={google.map((m, i): [string, ReactNode] => [
                google.length > 1 ? `Google account ${i + 1}` : "Google account",
                <span key={m.id}>
                  {m.email ?? "Linked"}
                  <span className="block text-xs text-muted">
                    Linked {when(m.linkedAt)} · last used {when(m.lastUsedAt)}
                  </span>
                </span>,
              ])}
            />
            <p className="text-muted">
              You can sign in with Google{a.hasPassword ? ` or with ${a.user.email} and your password` : ""}. Google confirms it&apos;s you; bizinsights never sees your Google
              password.
            </p>
          </>
        ) : a.canLinkGoogle ? (
          <p className="text-muted">
            Link your Google account to sign in to bizinsights with one click, whatever its email address. Google confirms it&apos;s you; bizinsights never sees your Google password,
            and we email you whenever a way to sign in is added.
          </p>
        ) : (
          <p className="text-muted">Google can&apos;t be linked to this account right now. Settings → Security shows how you sign in.</p>
        )}
      </IntegrationCard>
      <ConfirmDialog open={asking} title="Confirm it's you" confirmLabel={busy ? "Checking…" : "Continue to Google"} busy={busy || !password} onCancel={cancel} onConfirm={() => void continueWithPassword()}>
        <div className="space-y-3">
          <p>A linked Google account can sign in to your account, so enter your password first.</p>
          <PasswordField id="int-link-password" label="Your password" autoComplete="current-password" value={password} onChange={setPassword} />
        </div>
      </ConfirmDialog>
    </>
  );
}
