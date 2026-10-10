"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { actionError, api } from "@/lib/api";
import { WhatsappIcon } from "./common";
import type { Overview } from "./types";

// ---------------------------------------------------------------------------
// Meta's Embedded Signup (Facebook Login for Business, WhatsApp variation). The browser opens
// Meta's flow; Meta posts the chosen account and number ids to this window and hands back a
// code that lives 30 seconds, which the server exchanges for the business's token at once.
// No token ever reaches this page.
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

function loadFacebookSdk(appId: string, version: string): Promise<FbSdk> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB);
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const s = document.createElement("script");
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.onerror = () => reject(new Error("Meta's sign-in couldn't load. Check that nothing (an ad blocker) is blocking connect.facebook.net."));
    document.body.appendChild(s);
  });
}

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
  /** Where to say how it went (the WhatsApp pages' toasts, or a line on the page). */
  notify: (kind: "success" | "error", text: string) => void;
  label?: string;
}) {
  const toast = notify;
  const [busy, setBusy] = useState(false);
  const session = useRef<{ waba_id?: string; phone_number_id?: string; business_id?: string; event?: string } | null>(null);
  const code = useRef<string | null>(null);
  const done = useRef(false);

  // Needs the code (from FB.login) and, normally, the ids Meta posts to this window. If those
  // never arrive, `fallback` sends the code alone and the server asks Meta what was shared.
  const finish = useCallback(async (fallback = false) => {
    if (done.current || !code.current) return;
    const s = session.current;
    const ids = s?.waba_id && s.phone_number_id ? { wabaId: s.waba_id, phoneNumberId: s.phone_number_id, ...(s.business_id ? { businessId: s.business_id } : {}) } : null;
    if (!ids && !fallback) return;
    done.current = true;
    try {
      const r = await api<{ registration?: string }>(`${base}/embedded`, { method: "POST", body: { code: code.current, ...ids, ...(s?.event ? { event: s.event } : {}) } });
      toast("success", r.registration === "registered" || r.registration === "already" ? "WhatsApp is connected and your number can send messages." : "WhatsApp is connected. One more step: register your number on the WhatsApp page.");
      onConnected();
    } catch (e) {
      toast("error", actionError(e, "finish connecting"));
    } finally {
      setBusy(false);
    }
  }, [base, toast, onConnected]);

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
      if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event?.startsWith("FINISH")) {
        session.current = { ...data.data, event: data.event };
        if (!data.data?.phone_number_id) {
          done.current = true;
          toast("error", "Meta's sign-up finished without a phone number. Add a number to the account, then connect again.");
          setBusy(false);
          return;
        }
        void finish();
      } else if (data.event === "CANCEL") {
        setBusy(false);
        if (data.data?.error_message) toast("error", `Meta reported a problem: ${data.data.error_message}`);
      } else if (data.event === "ERROR") {
        setBusy(false);
        toast("error", `Meta reported a problem: ${data.data?.error_message ?? "unknown error"}`);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [finish, toast]);

  const start = async () => {
    if (!platform.appId || !platform.configId) return;
    setBusy(true);
    done.current = false;
    code.current = null;
    session.current = null;
    try {
      const FB = await loadFacebookSdk(platform.appId, platform.version ?? "v25.0");
      FB.login(
        (r) => {
          if (r.authResponse?.code) {
            code.current = r.authResponse.code;
            void finish();
            // The code lives 30 seconds: don't wait long for Meta's message.
            window.setTimeout(() => void finish(true), 4000);
          } else {
            setBusy(false);
          }
        },
        { config_id: platform.configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
      );
    } catch (e) {
      setBusy(false);
      toast("error", (e as Error).message);
    }
  };

  return (
    <button type="button" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#25D366] px-5 text-sm font-semibold text-[#0b3d20] shadow-sm transition hover:brightness-95 disabled:opacity-60" onClick={() => void start()} disabled={busy} data-testid="wa-connect">
      <WhatsappIcon size={20} /> {busy ? "Waiting for Meta…" : label}
    </button>
  );
}
