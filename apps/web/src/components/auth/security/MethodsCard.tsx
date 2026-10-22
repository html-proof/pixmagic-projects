"use client";
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Mail } from "lucide-react";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { GoogleIcon } from "@/components/BrandIcons";
import { PasswordField } from "@/components/auth/PasswordField";
import { linkErrorMessage, linkGoogle, linkNeedsPassword, prepareGoogleLink, removeSignInMethod, type AccountInfo } from "@/lib/auth";
import { CardHeader, day, failure, Pill, type Msg } from "./ui";

const METHOD_NAMES = { password: "Email and password", google: "Google" } as const;

/** What the page that linking Google came back to says (?linked=google, ?link_error=<code>), once. */
function useLinkResult(): [Msg, (m: Msg) => void] {
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const linked = q.get("linked");
    const linkError = q.get("link_error");
    if (!linked && !linkError) return;
    setMsg(linked === "google" ? { kind: "success", text: "Google is linked. You can now sign in with it too." } : { kind: linkError === "cancelled" ? "info" : "error", text: linkErrorMessage(linkError ?? "") });
    q.delete("linked");
    q.delete("link_error");
    const rest = q.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, []);
  return [msg, setMsg];
}

/** The ways into the account (email and password, Google): linking Google, and removing a method. */
export function MethodsCard({ account: a, onChanged }: { account: AccountInfo; onChanged: () => void }) {
  const [msg, setMsg] = useLinkResult();
  const [removing, setRemoving] = useState<AccountInfo["methods"][number] | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Linking after the first 15 minutes of a sign-in: the password first (the API asks for it too).
  const [confirmingLink, setConfirmingLink] = useState(false);
  const [linkPassword, setLinkPassword] = useState("");
  const cancel = useCallback(() => {
    setRemoving(null);
    setPassword("");
  }, []);
  const cancelLink = useCallback(() => {
    setConfirmingLink(false);
    setLinkPassword("");
  }, []);
  // A Google account under another address proves nothing about this one: the password, or nothing.
  const needsPassword = a.confirmWith === "password";
  const cantConfirm = a.confirmWith === "own_address_sign_in";

  function startLink() {
    if (linkNeedsPassword(a)) return setConfirmingLink(true);
    setLeaving(true);
    void linkGoogle(window.location.pathname);
  }

  async function linkWithPassword() {
    if (!linkPassword) return;
    setBusy(true);
    setMsg(null);
    try {
      await prepareGoogleLink(linkPassword);
      setLeaving(true);
      void linkGoogle(window.location.pathname);
    } catch (err) {
      setMsg(failure(err));
      setBusy(false);
    } finally {
      cancelLink();
    }
  }

  async function remove() {
    if (!removing || cantConfirm || (needsPassword && !password)) return;
    setBusy(true);
    setMsg(null);
    try {
      await removeSignInMethod(removing.id, needsPassword ? password : undefined);
      setMsg({ kind: "success", text: `${METHOD_NAMES[removing.method]} is no longer a way to sign in to your account.` });
      onChanged();
    } catch (err) {
      setMsg(failure(err));
    } finally {
      setBusy(false);
      cancel();
    }
  }

  return (
    <section className="card" aria-labelledby="methods-h">
      <CardHeader
        id="methods-h"
        t="violet"
        icon={KeyRound}
        title="How you sign in"
        sub={`${a.canLinkGoogle ? "Link a Google account to sign in with it too, whatever its email address. " : ""}We email you whenever a way to sign in is added or removed.`}
        action={
          a.canLinkGoogle ? (
            <button type="button" className="btn-secondary min-h-10 px-4" disabled={leaving} onClick={startLink}>
              <GoogleIcon size={16} />
              {leaving ? "Opening Google…" : "Link Google account"}
            </button>
          ) : undefined
        }
      />
      {msg && (
        <div className="mt-4">
          <Alert kind={msg.kind} onDismiss={() => setMsg(null)}>
            {msg.text}
          </Alert>
        </div>
      )}
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        {a.methods.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg/40 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-surface" aria-hidden>
                {m.method === "google" ? <GoogleIcon size={18} /> : <Mail size={18} className="text-muted" />}
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{METHOD_NAMES[m.method]}</span>
                  {m.method === a.signedInWith && <Pill t="good">Signed in with this now</Pill>}
                </p>
                {m.email && <p className="truncate text-muted">{m.email}</p>}
                <p className="text-xs text-muted">
                  Added {day(m.linkedAt)}
                  {m.lastUsedAt ? ` · last used ${day(m.lastUsedAt)}` : ""}
                </p>
              </div>
            </div>
            {/* Never the last way in, nor the one this session used (the API refuses both too). */}
            {a.methods.length > 1 && m.method !== a.signedInWith && (
              <button type="button" className="btn-secondary min-h-10 px-3.5" onClick={() => setRemoving(m)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirmingLink}
        title="Confirm it's you"
        confirmLabel={busy ? "Checking…" : "Continue to Google"}
        busy={busy}
        confirmDisabled={!linkPassword}
        onCancel={cancelLink}
        onConfirm={() => void linkWithPassword()}
      >
        <div className="space-y-3">
          <p>A linked Google account can sign in to your account, so enter your password first.</p>
          <PasswordField id="link-password" label="Your password" autoComplete="current-password" value={linkPassword} onChange={setLinkPassword} />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing ? METHOD_NAMES[removing.method] : ""}?`}
        confirmLabel={busy ? "Removing…" : "Remove"}
        danger
        busy={busy}
        confirmDisabled={cantConfirm || (needsPassword && !password)}
        onCancel={cancel}
        onConfirm={() => void remove()}
      >
        <div className="space-y-3">
          <p>
            {removing?.method === "google"
              ? "That Google account won't be able to sign in to your account any more, unless you link it again here."
              : "You won't be able to sign in with it any more. You can add it again later."}
          </p>
          <ConfirmItsYou account={a} id="remove-password" password={password} onPassword={setPassword} />
        </div>
      </ConfirmDialog>
    </section>
  );
}

/**
 * How a change that could lock the person out is confirmed (the account's `confirmWith`): their
 * password; a recent sign-in with Google using the account's address; or, signed in with a Google
 * account under another address and no password, a sign-in with the account's address first.
 */
export function ConfirmItsYou({ account: a, id, password, onPassword }: { account: AccountInfo; id: string; password: string; onPassword: (v: string) => void }) {
  if (a.confirmWith === "password") return <PasswordField id={id} label="Your password" autoComplete="current-password" value={password} onChange={onPassword} />;
  if (a.confirmWith === "recent_sign_in") return <p className="text-sm text-muted">For your safety this needs a sign-in in the last 15 minutes.</p>;
  return <p className="text-sm text-muted">To do this, sign out and sign in with Google using {a.user.email}, your account&apos;s address.</p>;
}
