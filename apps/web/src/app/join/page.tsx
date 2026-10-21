"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type FormEvent } from "react";
import { passwordProblems, passwordStrength } from "@app/shared/staff";
import { LoadError } from "@/components/LoadError";
import { PORTAL_WS_KEY } from "@/components/staff/PortalContext";
import { Alert, AuthShell } from "@/components/ui";
import { actionError, api, ApiError, isTransient, useApi } from "@/lib/api";
import { setReturnTo } from "@/lib/returnTo";
import { signOut } from "@/lib/auth";
import { writeLocal } from "@/lib/storage";

// ---------------------------------------------------------------------------------------------
// /join?token=…: an employee accepts their invitation. New to bizinsights: choose a password and the
// account is created and signed in (the API checks the password rules again; Cognito stores only a hash).
// Already have an account with that email: sign in, then join. The password only ever travels in
// the body of the one request that creates the account.
// ---------------------------------------------------------------------------------------------

type Lookup =
  | { ok: false; problem: "invalid" | "expired" | "used" | "revoked" | "inactive"; message: string }
  | { ok: true; employeeName: string; position: string; organization: string; email: string; expiresAt: string; accountExists: boolean };

type WhoAmI = { user: { email: string; emailVerified: boolean } | null };

const STRENGTH: Array<{ label: string; tone: string }> = [
  { label: "Too weak", tone: "bg-danger" },
  { label: "Weak", tone: "bg-danger" },
  { label: "Fair", tone: "bg-warn" },
  { label: "Good", tone: "bg-good" },
  { label: "Strong", tone: "bg-good" },
];

const GUIDANCE: Record<Extract<Lookup, { ok: false }>["problem"], string> = {
  invalid: "Copy the whole link from your invitation email, or ask your manager to send a new invitation.",
  expired: "Invitations only work for a limited time. Your manager can send you a new one from bizinsights.",
  used: "If you already set up your account, sign in with the email address the invitation was sent to.",
  revoked: "Look for a newer invitation email, or ask your manager to send you one.",
  inactive: "Your employer has deactivated this employee record. Contact them if you think that's a mistake.",
};

function Join() {
  const token = useSearchParams().get("token") ?? "";
  const usable = token.length >= 10 && token.length <= 200;
  const lookup = useApi<Lookup>(usable ? `/staff/invitations/lookup?token=${encodeURIComponent(token)}` : null);
  const [dead, setDead] = useState<string | null>(null);

  if (!usable) return <Problem title="This invitation link isn't valid" message="The link is incomplete." guidance={GUIDANCE.invalid} />;
  if (dead) return <Problem title="This invitation can't be used" message={dead} guidance="Ask your manager to send you a new invitation." />;
  if (lookup.error && !lookup.data) {
    return (
      <AuthShell title="Join your team">
        <LoadError what="your invitation" error={lookup.error} onRetry={() => void lookup.reload()} busy={lookup.loading} />
      </AuthShell>
    );
  }
  if (!lookup.data) {
    return (
      <AuthShell title="Join your team">
        <p className="text-sm text-muted">Checking your invitation…</p>
      </AuthShell>
    );
  }
  const inv = lookup.data;
  if (!inv.ok) {
    const title = inv.problem === "expired" ? "This invitation has expired" : inv.problem === "used" ? "This invitation has already been used" : "This invitation can't be used";
    return <Problem title={title} message={inv.message} guidance={GUIDANCE[inv.problem]} signIn={inv.problem === "used"} />;
  }
  return <Accept token={token} inv={inv} onDead={setDead} />;
}

function Problem({ title, message, guidance, signIn = false }: { title: string; message: string; guidance: string; signIn?: boolean }) {
  return (
    <AuthShell title={title}>
      <Alert>{message}</Alert>
      <p className="text-sm text-muted">{guidance}</p>
      <Link
        href="/login"
        prefetch={false}
        className={signIn ? "btn-primary w-full" : "btn-secondary w-full"}
        onClick={() => {
          if (signIn) setReturnTo("/portal");
        }}
      >
        Go to sign in
      </Link>
    </AuthShell>
  );
}

function Accept({ token, inv, onDead }: { token: string; inv: Extract<Lookup, { ok: true }>; onDead: (message: string) => void }) {
  const router = useRouter();
  const joinPath = `/join?token=${encodeURIComponent(token)}`;
  // Who is signed in on this browser, if anyone: undefined until known.
  const [who, setWho] = useState<WhoAmI["user"] | undefined>(undefined);
  // The API said an account already exists for this email (from the lookup, or when creating one).
  const [hasAccount, setHasAccount] = useState(inv.accountExists);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<WhoAmI>("/auth/whoami")
      .then((w) => live && setWho(w.user))
      .catch(() => live && setWho(null));
    return () => {
      live = false;
    };
  }, []);

  const signedInAsInvitee = !!who && who.email.toLowerCase() === inv.email.toLowerCase();
  const expires = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(inv.expiresAt));

  return (
    <AuthShell title={`Join ${inv.organization}`} subtitle="Set up your employee account to clock in and out, see your hours and download your payslips.">
      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-surface p-4 text-sm">
        <div className="min-w-0">
          <dt className="text-xs text-muted">Organization</dt>
          <dd className="truncate font-medium">{inv.organization}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Name</dt>
          <dd className="truncate font-medium">{inv.employeeName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Position</dt>
          <dd className="truncate font-medium">{inv.position || "—"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted">Invitation expires</dt>
          <dd className="truncate font-medium">{expires}</dd>
        </div>
      </dl>
      {info && <Alert kind="info">{info}</Alert>}

      {who === undefined ? (
        <p className="text-sm text-muted">One moment…</p>
      ) : signedInAsInvitee ? (
        <JoinExisting token={token} inv={inv} emailVerified={who.emailVerified} joinPath={joinPath} onDead={onDead} />
      ) : hasAccount ? (
        <SignInToJoin inv={inv} who={who} joinPath={joinPath} />
      ) : (
        <CreateAccount
          token={token}
          inv={inv}
          onDead={onDead}
          onAccountExists={(message) => {
            setHasAccount(true);
            setInfo(message);
          }}
          router={router}
        />
      )}
    </AuthShell>
  );
}

/** Signed in already, with the invited email: one click joins. */
function JoinExisting({ token, inv, emailVerified, joinPath, onDead }: { token: string; inv: Extract<Lookup, { ok: true }>; emailVerified: boolean; joinPath: string; onDead: (m: string) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const { workspaceId } = await api<{ workspaceId: string }>("/staff/invitations/accept-existing", { method: "POST", body: { token } });
      writeLocal(PORTAL_WS_KEY, workspaceId);
      router.replace("/portal");
    } catch (e) {
      const code = e instanceof ApiError ? e.code : "";
      if (code.startsWith("invitation_")) onDead((e as Error).message);
      else if (code === "email_unverified") {
        setReturnTo(joinPath);
        setError((e as Error).message);
      } else setError(e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a minute and try again." : actionError(e, "join"));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        You&apos;re signed in as <span className="font-medium">{inv.email}</span>.
      </p>
      {!emailVerified && (
        <Alert kind="info">
          Verify your email address first.{" "}
          <Link className="underline" href="/verify-email" onClick={() => setReturnTo(joinPath)}>
            Verify now
          </Link>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <button type="button" className="btn-primary min-h-12 w-full" onClick={() => void join()} disabled={busy}>
        {busy ? "Joining…" : `Join ${inv.organization}`}
      </button>
    </div>
  );
}

/** An account exists for this email: sign in with it, and come back here to join. */
function SignInToJoin({ inv, who, joinPath }: { inv: Extract<Lookup, { ok: true }>; who: WhoAmI["user"]; joinPath: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    setReturnTo(joinPath);
    if (who) {
      // Signed in as someone else: sign that account out first, on this browser only.
      await signOut();
      router.push("/login?signedOut=1");
      return;
    }
    router.push("/login");
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        You already have a bizinsights account with <span className="font-medium">{inv.email}</span>. Sign in with it, and you&apos;ll come back here to join {inv.organization}.
      </p>
      {who && (
        <Alert kind="info">
          You&apos;re signed in as {who.email}. This invitation is for {inv.email}, so you&apos;ll be signed out first.
        </Alert>
      )}
      <button type="button" className="btn-primary min-h-12 w-full" onClick={() => void go()} disabled={busy}>
        Sign in to join
      </button>
      <Link prefetch={false} href="/forgot-password" className="block text-sm text-muted underline">
        Forgot your password?
      </Link>
    </div>
  );
}

/** New to bizinsights: choose a password, and the account is created and signed in. */
function CreateAccount({
  token,
  inv,
  onDead,
  onAccountExists,
  router,
}: {
  token: string;
  inv: Extract<Lookup, { ok: true }>;
  onDead: (message: string) => void;
  onAccountExists: (message: string) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  const ctx = useMemo(() => ({ email: inv.email, name: inv.employeeName }), [inv.email, inv.employeeName]);
  const problems = passwordProblems(pw, ctx);
  // The checklist: the rules every password starts out breaking, plus any other rule it has broken
  // while being typed, each ticked once it's met. The rule texts come from @app/shared/staff.
  const [seen, setSeen] = useState<string[]>(() => passwordProblems("", ctx));
  const strength = passwordStrength(pw, ctx);
  const matches = pw2.length > 0 && pw === pw2;
  const ready = problems.length === 0 && matches && !busy;

  function onPassword(v: string) {
    setPw(v);
    setServerProblems([]);
    const now = passwordProblems(v, ctx);
    setSeen((s) => (now.some((p) => !s.includes(p)) ? [...s, ...now.filter((p) => !s.includes(p))] : s));
  }

  async function activate(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setServerProblems([]);
    let res: { emailVerified: boolean; workspaceId: string };
    try {
      res = await api("/staff/invitations/accept", { method: "POST", body: { token, password: pw, confirmPassword: pw2 } });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (code === "weak_password") {
        const list = (err as ApiError).data.problems;
        setServerProblems(Array.isArray(list) && list.length ? list.map(String) : [(err as Error).message]);
      } else if (code === "account_exists") onAccountExists((err as Error).message);
      else if (code.startsWith("invitation_")) onDead((err as Error).message);
      else if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a minute, then try again.");
      else if (isTransient(err)) setError("We couldn't create your account just now. Nothing was saved; please try again in a moment.");
      else setError((err as Error).message);
      setBusy(false);
      return;
    }
    writeLocal(PORTAL_WS_KEY, res.workspaceId);
    // Accepting signed this browser in already (the API set the session cookie).
    if (res.emailVerified) {
      router.replace("/portal");
      return;
    }
    // A copied link doesn't prove the inbox: verify it with a code first (/verify-email sends it).
    setReturnTo("/portal");
    router.replace("/verify-email");
  }



  const shown = serverProblems.length ? serverProblems : null;
  return (
    <form onSubmit={activate} className="space-y-4" noValidate>
      <div>
        <label className="label" htmlFor="join-email">
          Email
        </label>
        <input id="join-email" className="input min-h-11 bg-bg text-muted" type="email" autoComplete="username" value={inv.email} readOnly />
        <p className="mt-1 text-xs text-muted">You&apos;ll sign in with this email address.</p>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <label className="label" htmlFor="join-pw">
            Create password
          </label>
          <button type="button" className="text-xs text-muted underline" aria-pressed={show} aria-controls="join-pw join-pw2" onClick={() => setShow((s) => !s)}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <input
          id="join-pw"
          className="input min-h-11"
          type={show ? "text" : "password"}
          autoComplete="new-password"
          maxLength={200}
          value={pw}
          onChange={(e) => onPassword(e.target.value)}
          aria-describedby="join-pw-rules join-pw-strength"
          aria-invalid={pw.length > 0 && problems.length > 0}
        />
        <div id="join-pw-strength" className="mt-2" aria-live="polite">
          <div className="flex gap-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={`h-1.5 flex-1 rounded-full ${pw && strength >= i ? STRENGTH[strength]!.tone : pw && i === 1 ? STRENGTH[0]!.tone : "bg-border"}`} />
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{pw ? `Strength: ${STRENGTH[strength]!.label}` : "Choose a password you don't use anywhere else."}</p>
        </div>
        <ul id="join-pw-rules" className="mt-2 space-y-1 text-xs" aria-label="Password requirements">
          {seen.map((rule) => {
            const met = pw.length > 0 && !problems.includes(rule);
            return (
              <li key={rule} className={`flex items-start gap-1.5 ${met ? "text-good" : "text-muted"}`}>
                <span aria-hidden className="w-3 shrink-0 font-semibold">
                  {met ? "✓" : "•"}
                </span>
                <span>
                  {rule}
                  <span className="sr-only">{met ? " (done)" : " (not yet)"}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <div>
        <label className="label" htmlFor="join-pw2">
          Confirm password
        </label>
        <input id="join-pw2" className="input min-h-11" type={show ? "text" : "password"} autoComplete="new-password" maxLength={200} value={pw2} onChange={(e) => setPw2(e.target.value)} aria-describedby="join-pw2-match" />
        <p id="join-pw2-match" className={`mt-1 text-xs ${pw2 && !matches ? "text-danger" : matches ? "text-good" : "text-muted"}`} aria-live="polite">
          {!pw2 ? "Type the same password again." : matches ? "✓ The passwords match." : "The passwords don't match yet."}
        </p>
      </div>

      {shown && (
        <Alert>
          <ul className="list-inside list-disc">
            {shown.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}

      <button type="submit" className="btn-primary min-h-12 w-full" disabled={!ready}>
        {busy ? "Activating…" : "Activate my account"}
      </button>
      <p className="text-xs text-muted">
        Already have an account with {inv.email}?{" "}
        <button type="button" className="underline" onClick={() => onAccountExists(`Sign in with ${inv.email}, and you'll come back here to join ${inv.organization}.`)}>
          Sign in instead
        </button>
      </p>
    </form>
  );
}

export default function JoinPage() {
  return (
    <Suspense>
      <Join />
    </Suspense>
  );
}
