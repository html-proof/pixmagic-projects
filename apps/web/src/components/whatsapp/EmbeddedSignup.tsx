"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionError, api } from "@/lib/api";
import { WhatsappIcon } from "./Common";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// Meta's Embedded Signup (Facebook Login for Business, WhatsApp variation). The browser opens
// Meta's flow; Meta posts the chosen account and number ids to this window and hands back a
// code that lives 30 seconds, which the server exchanges for the business's token at once (and
// checks the ids against what Meta says was granted). No token ever reaches this page, and a
// window that closes is never taken for a connection: only the server's answer is.
// ---------------------------------------------------------------------------

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}
interface FbSdk {
  init(opts: Record<string, unknown>): void;
  login(cb: (r: FbLoginResponse) => void, opts: Record<string, unknown>): void;
}
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

/** The SDK, loaded once per page however many buttons ask for it. */
let sdk: Promise<FbSdk> | null = null;
function loadFacebookSdk(appId: string, version: string): Promise<FbSdk> {
  if (window.FB) return Promise.resolve(window.FB);
  sdk ??= new Promise<FbSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => {
      sdk = null;
      s.remove();
      reject(new Error("Meta's sign-in couldn't load. Check your connection, and that nothing (an ad blocker) is blocking connect.facebook.net."));
    };
    document.body.appendChild(s);
  });
  return sdk;
}

type Phase =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "authorizing" }
  | { kind: "configuring" }
  | { kind: "connected"; text: string }
  | { kind: "stopped"; text: string; tone: "info" | "error" };

/** Under this, a window that "closed" never really opened: the browser blocked it. */
const BLOCKED_MS = 1500;

/** Meta's step names in a cancelled session, in words. */
const STEP: Record<string, string> = {
  BUSINESS_ACCOUNT_SELECTION: "choosing your business",
  WABA_SELECTION: "choosing the WhatsApp Business Account",
  PHONE_NUMBER_SETUP: "adding the phone number",
  PHONE_NUMBER_VERIFICATION: "verifying the phone number",
  PERMISSIONS: "reviewing permissions",
};

export function EmbeddedSignup({
  base,
  platform,
  onConnected,
  notify,
  label = "Continue with WhatsApp",
}: {
  /** The store's WhatsApp API path (/workspaces/:ws/stores/:storeId/whatsapp). */
  base: string;
  platform: Overview["platform"];
  onConnected: () => void;
  /** Where to announce a finished connection (the WhatsApp pages' toasts, or a line on the page). */
  notify: (kind: "success" | "error", text: string) => void;
  label?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const session = useRef<{ waba_id?: string; phone_number_id?: string; business_id?: string; event?: string } | null>(null);
  const code = useRef<string | null>(null);
  const done = useRef(false);
  const cancelled = useRef<{ step?: string; error?: string } | null>(null);
  const openedAt = useRef(0);

  const stop = useCallback((text: string, tone: "info" | "error" = "error") => {
    done.current = true;
    setPhase({ kind: "stopped", text, tone });
  }, []);

  // Needs the code (from FB.login) and, normally, the ids Meta posts to this window. If those
  // never arrive, `fallback` sends the code alone and the server asks Meta what was shared.
  const finish = useCallback(
    async (fallback = false) => {
      if (done.current || !code.current) return;
      const s = session.current;
      const ids = s?.waba_id && s.phone_number_id ? { wabaId: s.waba_id, phoneNumberId: s.phone_number_id, ...(s.business_id ? { businessId: s.business_id } : {}) } : null;
      if (!ids && !fallback) return;
      done.current = true;
      setPhase({ kind: "configuring" });
      try {
        const r = await api<{ registration?: string }>(`${base}/embedded`, { method: "POST", body: { code: code.current, ...ids, ...(s?.event ? { event: s.event } : {}) } });
        const ready = r.registration === "registered" || r.registration === "already";
        const text = ready
          ? "WhatsApp Business connected successfully. Your number can send messages."
          : "WhatsApp Business is connected. Action required: your number already has a two-step verification PIN; enter it on the WhatsApp page to start sending.";
        setPhase({ kind: "connected", text });
        notify("success", text);
        onConnected();
      } catch (e) {
        setPhase({ kind: "stopped", text: actionError(e, "finish connecting"), tone: "error" });
      }
    },
    [base, notify, onConnected],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let host = "";
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      let data: { type?: string; event?: string; data?: Record<string, string> };
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== "WA_EMBEDDED_SIGNUP" || typeof data.event !== "string") return;
      if (data.event.startsWith("FINISH")) {
        session.current = { ...data.data, event: data.event };
        if (!data.data?.phone_number_id) {
          stop("Meta's setup finished without a phone number. Add or verify a number in the WhatsApp Business Account, then press the button again.");
          return;
        }
        setPhase({ kind: "configuring" });
        void finish();
      } else if (data.event === "CANCEL") {
        cancelled.current = { step: data.data?.current_step, error: data.data?.error_message };
      } else if (data.event === "ERROR") {
        stop("Meta could not complete setup. Please try again.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish, stop]);

  const start = async () => {
    if (!platform.appId || !platform.configId) return;
    setPhase({ kind: "opening" });
    done.current = false;
    code.current = null;
    session.current = null;
    cancelled.current = null;
    let FB: FbSdk;
    try {
      FB = await loadFacebookSdk(platform.appId, platform.version ?? "v25.0");
    } catch (e) {
      stop("We couldn't open the connection service. Check your internet connection and try again.");
      return;
    }
    openedAt.current = Date.now();
    setPhase({ kind: "authorizing" });
    FB.login(
      (r) => {
        if (r.authResponse?.code) {
          code.current = r.authResponse.code;
          void finish();
          // The code lives 30 seconds: don't wait long for Meta's message.
          window.setTimeout(() => void finish(true), 4000);
          return;
        }
        if (done.current) return;
        // The window closed without a code: nothing is connected.
        const c = cancelled.current;
        if (c?.error) stop("Meta could not complete setup. Nothing was connected; please try again.");
        else if (Date.now() - openedAt.current < BLOCKED_MS && !c) stop("Meta's window didn't open. Allow pop-ups for this site in your browser, then press the button again.");
        else stop(`Meta's window was closed${c?.step ? ` while ${STEP[c.step] ?? "completing setup"}` : ""} before the setup finished. Nothing was connected.`, "info");
      },
      { config_id: platform.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
    );
  };

  const busy = phase.kind === "opening" || phase.kind === "authorizing" || phase.kind === "configuring";
  const status =
    phase.kind === "opening" ? "Opening secure Meta connection…"
    : phase.kind === "authorizing" ? "Complete the setup in the Meta window."
    : phase.kind === "configuring" ? "Connecting your WhatsApp Business account…"
    : phase.kind === "stopped" ? phase.text
    : null; // "connected" is announced by the page (notify), which also redraws with the new connection.

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] shadow-sm transition hover:brightness-95 disabled:opacity-60"
        onClick={() => void start()}
        disabled={busy}
        data-testid="wa-connect"
      >
        <WhatsappIcon size={20} /> {busy ? "Waiting for Meta…" : phase.kind === "stopped" ? "Try again" : label}
      </button>
      {status && (
        <p
          role={phase.kind === "stopped" && phase.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          className={`flex items-start gap-2 text-sm ${phase.kind === "stopped" && phase.tone === "error" ? "text-danger" : "text-muted"}`}
          data-testid="wa-connect-status"
          data-phase={phase.kind}
        >
          {busy && <span aria-hidden className="mt-1 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          <span>{status}</span>
        </p>
      )}
    </div>
  );
}
