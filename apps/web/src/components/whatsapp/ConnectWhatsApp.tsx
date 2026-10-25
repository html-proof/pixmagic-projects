"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { parseEmbeddedSignupMessage, signupMayBeMetaLimit, signupStepLabel, type EmbeddedSignupEvent } from "@app/shared/whatsapp";
import { useToast } from "@/components/AppUi";
import { api } from "@/lib/api";
import { MetaLimitHelp } from "./Status";
import type { WaConnection, WaPlatform } from "./types";
import { waError, WhatsappIcon } from "./WaUi";

// ---------------------------------------------------------------------------
// "Connect WhatsApp": Meta's Embedded Signup (Facebook Login for Business, its WhatsApp variation,
// v4). The server hands out the public ids and a nonce; Meta's window does the sign-in, the
// business, the WhatsApp Business account and the number; Meta posts what was chosen to this
// window and gives back a code that lives 30 seconds, which the server exchanges at once and checks
// against what Meta says was granted. No token reaches this page, and a window that closes is never
// taken for a connection: only the server's answer is.
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

/** The SDK, loaded once per page however many buttons ask for it (and ready before the click: see `start`). */
let sdk: Promise<FbSdk> | null = null;
let loaded: FbSdk | null = null;
function loadFacebookSdk(appId: string, version: string): Promise<FbSdk> {
  if (window.FB) {
    if (!loaded) window.FB.init({ appId, xfbml: false, cookie: false, version });
    loaded = window.FB;
    return Promise.resolve(window.FB);
  }
  sdk ??= new Promise<FbSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, xfbml: false, cookie: false, version });
      loaded = window.FB!;
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
  /** `metaLimit`: Meta's window stopped where Meta's limits on the business portfolio may be why. */
  | { kind: "stopped"; text: string; tone: "info" | "error"; metaLimit?: boolean };

/** Under this, a window that "closed" never really opened: the browser blocked it. */
const BLOCKED_MS = 1500;
/** How long to wait for Meta's message after the code arrives (the code itself lives 30 seconds). */
const WAIT_FOR_IDS_MS = 3000;

export function ConnectWhatsApp({
  base,
  platform,
  onConnected,
  label = "Connect WhatsApp",
  look = "whatsapp",
}: {
  /** The store's WhatsApp API path (/workspaces/:ws/stores/:storeId/whatsapp). */
  base: string;
  /** The overview's `platform`: whether connecting is switched on, and Meta's public ids. */
  platform: WaPlatform;
  onConnected: (connection: WaConnection) => void;
  label?: string;
  /** "row": a row's button on Settings → Integrations instead of WhatsApp's own green. */
  look?: "whatsapp" | "row";
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const nonce = useRef<Promise<string> | null>(null);
  const code = useRef<string | null>(null);
  const finished = useRef<Extract<EmbeddedSignupEvent, { type: "finish" }> | null>(null);
  const cancelled = useRef<{ step: string | null } | null>(null);
  const failed = useRef<{ message: string; code: string | null } | null>(null);
  const done = useRef(false);
  const openedAt = useRef(0);
  const waitTimer = useRef<number | undefined>(undefined);

  const stop = useCallback((text: string, tone: "info" | "error" = "error", metaLimit = false) => {
    done.current = true;
    window.clearTimeout(waitTimer.current);
    setPhase({ kind: "stopped", text, tone, metaLimit });
  }, []);

  /** Send the code (and the ids Meta posted, when they came) to the server: only its answer connects anything. */
  const finish = useCallback(async () => {
    if (done.current || !code.current || !nonce.current) return;
    done.current = true;
    window.clearTimeout(waitTimer.current);
    setPhase({ kind: "configuring" });
    const f = finished.current;
    try {
      const r = await api<{ connection: WaConnection }>(`${base}/connect/finish`, {
        method: "POST",
        body: {
          nonce: await nonce.current,
          code: code.current,
          flow: f?.flow ?? null,
          wabaId: f?.wabaId ?? null,
          phoneNumberId: f?.phoneNumberId ?? null,
          businessId: f?.businessId ?? null,
        },
      });
      setPhase({ kind: "idle" });
      const c = r.connection;
      toast("success", c.status === "active" ? `WhatsApp is connected: ${c.verifiedName ?? c.displayPhoneNumber ?? "your number"} can send messages.` : "WhatsApp is connected. One more step is needed before it can send: see below.");
      onConnected(c);
    } catch (e) {
      setPhase({ kind: "stopped", text: waError(e, "finish connecting WhatsApp"), tone: "error" });
    }
  }, [base, onConnected, toast]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let host = "";
      try {
        host = new URL(event.origin).hostname;
      } catch {
        return;
      }
      // Only Meta's own window speaks for Meta.
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      const m = parseEmbeddedSignupMessage(event.data);
      if (!m) return;
      if (m.type === "finish") {
        finished.current = m;
        if (code.current) void finish();
      } else if (m.type === "cancel") {
        cancelled.current = { step: m.step };
      } else {
        failed.current = { message: m.message ?? "unknown error", code: m.code };
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish]);

  useEffect(() => () => window.clearTimeout(waitTimer.current), []);

  // Meta's SDK is loaded as soon as the button shows, so the click can open Meta's window at once:
  // browsers block a pop-up opened after awaiting a request.
  const { ready, appId, configId, version } = platform;
  useEffect(() => {
    if (ready && appId && version) void loadFacebookSdk(appId, version).catch(() => undefined);
  }, [ready, appId, version]);

  const start = async () => {
    if (!appId || !configId || !version) return;
    setPhase({ kind: "opening" });
    done.current = false;
    code.current = null;
    finished.current = null;
    cancelled.current = null;
    failed.current = null;
    // The nonce is asked for alongside Meta's window: only the finish needs it.
    const ask = api<{ nonce: string }>(`${base}/connect/start`, { method: "POST", body: {} }).then((s) => s.nonce);
    nonce.current = ask;
    ask.catch((e: unknown) => {
      if (nonce.current === ask) stop(waError(e, "start connecting WhatsApp"));
    });
    try {
      // Opened straight from the click when the SDK is already loaded (it nearly always is).
      const FB = loaded ?? (await loadFacebookSdk(appId, version));
      openedAt.current = Date.now();
      setPhase({ kind: "authorizing" });
      FB.login(
        (r) => {
          if (r.authResponse?.code) {
            code.current = r.authResponse.code;
            // Meta's message with the chosen account and number usually comes first; wait a moment if not.
            if (finished.current) void finish();
            else waitTimer.current = window.setTimeout(() => void finish(), WAIT_FOR_IDS_MS);
            return;
          }
          if (done.current) return;
          // The window closed without a code: nothing is connected.
          const c = cancelled.current;
          const f = failed.current;
          if (f) stop(`Meta reported a problem: ${f.message}${f.code ? ` (Meta's error ${f.code})` : ""}. Nothing was connected.`, "error", true);
          else if (Date.now() - openedAt.current < BLOCKED_MS && !c) stop("Meta's window didn't open. Allow pop-ups for this site in your browser, then try again.");
          else {
            // Meta's window can also crash on its own screen about the portfolio's limits and post
            // nothing: the step it was closed at is all this page learns (signupMayBeMetaLimit).
            const where = signupStepLabel(c?.step);
            stop(`Meta's window was closed${where ? ` while ${where}` : ""} before the setup finished. Nothing was connected.`, "info", signupMayBeMetaLimit(c?.step));
          }
        },
        { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (e) {
      stop(e instanceof Error && !("status" in e) ? e.message : waError(e, "start connecting WhatsApp"));
    }
  };

  const busy = phase.kind === "opening" || phase.kind === "authorizing" || phase.kind === "configuring";
  const status =
    phase.kind === "opening"
      ? "Opening Meta's secure window…"
      : phase.kind === "authorizing"
        ? "Finish the steps in Meta's window."
        : phase.kind === "configuring"
          ? "Checking and setting up your number…"
          : phase.kind === "stopped"
            ? phase.text
            : null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={
          look === "row"
            ? "btn-primary h-11 px-5 font-semibold"
            : "inline-flex h-11 items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] shadow-sm transition hover:brightness-95 disabled:opacity-60"
        }
        onClick={() => void start()}
        disabled={busy || !ready || !appId}
        aria-label={look === "row" && !busy && phase.kind !== "stopped" ? `${label} WhatsApp` : undefined}
        data-testid="wa-connect"
      >
        {look === "row" ? <Link2 size={17} strokeWidth={2.2} aria-hidden /> : <WhatsappIcon size={20} />} {busy ? "Waiting for Meta…" : phase.kind === "stopped" ? "Try again" : label}
      </button>
      {status && (
        <p
          role={phase.kind === "stopped" && phase.tone === "error" ? "alert" : "status"}
          aria-live="polite"
          className={`flex items-start gap-2 text-sm ${look === "row" ? "max-w-xs" : "max-w-md"} ${phase.kind === "stopped" && phase.tone === "error" ? "text-danger" : "text-muted"}`}
          data-testid="wa-connect-status"
          data-phase={phase.kind}
        >
          {busy && <span aria-hidden className="mt-1 inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          <span>{status}</span>
        </p>
      )}
      {phase.kind === "stopped" && phase.metaLimit && <MetaLimitHelp className={look === "row" ? "max-w-xs" : "max-w-md"} />}
    </div>
  );
}
