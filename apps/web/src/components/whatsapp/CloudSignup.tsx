"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseEmbeddedSignupMessage, signupStepLabel, type EmbeddedSignupEvent } from "@app/shared/whatsapp";
import { useToast } from "@/components/AppUi";
import { api } from "@/lib/api";
import type { WaConnection } from "./types";
import { waError, WhatsappIcon } from "./WaUi";

// ---------------------------------------------------------------------------
// The Cloud API way to connect: Meta's Embedded Signup (Facebook Login for Business, its WhatsApp
// variation, v4). Meta's window does the sign-in, the business, the WhatsApp Business account and
// the number; Meta posts what was chosen to this window and gives back a code that lives 30
// seconds, which the server exchanges at once and checks against what Meta says was granted
// (core whatsapp/cloud.ts). No token reaches this page, and a window that closes is never taken for
// a connection: only the server's answer is.
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

/** The SDK, loaded once per page (and before the click: a pop-up opened after awaiting a request is blocked). */
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

type Phase = { kind: "idle" } | { kind: "authorizing"; since: number } | { kind: "configuring" } | { kind: "stopped"; text: string; tone: "info" | "error" };

/** Under this, a window that "closed" never really opened: the browser blocked it. */
const BLOCKED_MS = 1500;
/** How long to wait for Meta's message after the code arrives. */
const WAIT_FOR_IDS_MS = 3000;

export function CloudSignup({ base, signup, onConnected }: { base: string; signup: { appId: string; configId: string; version: string }; onConnected: (c: WaConnection) => void }) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [slow, setSlow] = useState(false);
  const code = useRef<string | null>(null);
  const finished = useRef<Extract<EmbeddedSignupEvent, { type: "finish" }> | null>(null);
  const cancelled = useRef<{ step: string | null } | null>(null);
  const failed = useRef<string | null>(null);
  const done = useRef(false);
  const openedAt = useRef(0);
  const waitTimer = useRef<number | undefined>(undefined);

  const stop = useCallback((text: string, tone: "info" | "error" = "error") => {
    done.current = true;
    window.clearTimeout(waitTimer.current);
    setPhase({ kind: "stopped", text, tone });
  }, []);

  const finish = useCallback(async () => {
    if (done.current || !code.current) return;
    const f = finished.current;
    if (!f?.wabaId || !f.phoneNumberId) {
      stop(f && f.flow !== "cloud_api" ? "Meta's window finished without a number set up for the Cloud API. Open it again and add or pick a phone number." : "Meta didn't say which account and number you picked. Open Meta's window again.");
      return;
    }
    done.current = true;
    window.clearTimeout(waitTimer.current);
    setPhase({ kind: "configuring" });
    try {
      const r = await api<{ connection: WaConnection }>(`${base}/connection/cloud`, { method: "POST", body: { code: code.current, wabaId: f.wabaId, phoneNumberId: f.phoneNumberId, businessId: f.businessId } });
      setPhase({ kind: "idle" });
      toast("success", `WhatsApp is connected through Meta's Cloud API${r.connection.phone ? `: ${r.connection.phone}` : ""}.`);
      onConnected(r.connection);
    } catch (e) {
      setPhase({ kind: "stopped", text: waError(e, "finish connecting WhatsApp"), tone: "error" });
    }
  }, [base, onConnected, stop, toast]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      let host: string;
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
      } else if (m.type === "cancel") cancelled.current = { step: m.step };
      else failed.current = m.message ?? "unknown error";
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish]);

  useEffect(() => () => window.clearTimeout(waitTimer.current), []);
  useEffect(() => {
    void loadFacebookSdk(signup.appId, signup.version).catch(() => undefined);
  }, [signup.appId, signup.version]);
  // Meta's window can stop on its own page (before bizinsights is approved as a Tech Provider): say so after a while.
  useEffect(() => {
    if (phase.kind !== "authorizing") return setSlow(false);
    const t = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(t);
  }, [phase]);

  const start = async () => {
    done.current = false;
    code.current = null;
    finished.current = null;
    cancelled.current = null;
    failed.current = null;
    try {
      const FB = loaded ?? (await loadFacebookSdk(signup.appId, signup.version));
      openedAt.current = Date.now();
      setPhase({ kind: "authorizing", since: openedAt.current });
      FB.login(
        (r) => {
          if (r.authResponse?.code) {
            code.current = r.authResponse.code;
            if (finished.current) void finish();
            else waitTimer.current = window.setTimeout(() => void finish(), WAIT_FOR_IDS_MS);
            return;
          }
          if (done.current) return;
          const c = cancelled.current;
          if (failed.current) stop(`Meta reported a problem: ${failed.current}. Nothing was connected.`);
          else if (Date.now() - openedAt.current < BLOCKED_MS && !c) stop("Meta's window didn't open. Allow pop-ups for this site, then try again.");
          else {
            const where = signupStepLabel(c?.step);
            stop(`Meta's window was closed${where ? ` while ${where}` : ""} before the setup finished. Nothing was connected.`, "info");
          }
        },
        { config_id: signup.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (e) {
      stop(e instanceof Error && !("status" in e) ? e.message : waError(e, "start connecting WhatsApp"));
    }
  };

  const busy = phase.kind === "authorizing" || phase.kind === "configuring";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary h-11 px-5"
          onClick={() => void start()}
          disabled={busy}
          data-testid="wa-cloud-connect"
        >
          <WhatsappIcon size={20} /> {busy ? "Waiting for Meta…" : phase.kind === "stopped" ? "Try again" : "Continue with Meta"}
        </button>
        {phase.kind === "authorizing" && (
          <button type="button" className="btn-secondary h-11" onClick={() => stop("You stopped waiting for Meta's window. Nothing was connected.", "info")}>
            Stop waiting
          </button>
        )}
      </div>
      {phase.kind !== "idle" && (
        <p role={phase.kind === "stopped" && phase.tone === "error" ? "alert" : "status"} aria-live="polite" className={`max-w-xl text-sm ${phase.kind === "stopped" && phase.tone === "error" ? "text-danger" : "text-muted"}`}>
          {phase.kind === "authorizing" && (slow ? "Still in Meta's window. If it stopped on \"can't onboard customers right now\", Meta hasn't approved bizinsights for the Cloud API yet: use the QR code instead for now." : "Finish the steps in Meta's window.")}
          {phase.kind === "configuring" && "Checking with Meta and setting up your number…"}
          {phase.kind === "stopped" && phase.text}
        </p>
      )}
    </div>
  );
}
