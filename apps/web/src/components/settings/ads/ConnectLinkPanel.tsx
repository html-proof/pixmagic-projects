"use client";
import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { Alert } from "@/components/ui";
import { actionError, api, ApiError, useApi } from "@/lib/api";
import { PanelTitle, tone } from "./ui";

/** The store's connect link, as GET/POST …/ads/meta/link answers it (apps/api/src/routes/adLinks.ts). */
interface ConnectLink {
  url: string;
  createdAt: string;
  expiresAt: string;
  createdBy: { name: string | null; you: boolean } | null;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** Why a link couldn't be made, in words. */
function makeError(e: unknown): string {
  if (e instanceof ApiError && e.code === "rate_limited") return "That's a lot of new links in a short time. Wait a few minutes, then try again.";
  if (e instanceof ApiError && e.code === "not_configured") return "Meta Ads isn't set up for bizinsights yet, so there's nothing to link to. It's on our side, not yours: please try again later.";
  return actionError(e, "make the link");
}

/**
 * On the Meta Ads card, for people who manage the store's integrations: a link for whoever runs the
 * store's Facebook ads (an agency, a colleague), who signs in with Facebook on the link's page and picks
 * the ad accounts without a bizinsights login (app/connect/meta). One link per store, used up by the
 * connection made with it, ending after 7 days; making another or turning it off ends the one before.
 */
export function ConnectLinkPanel({ base, storeName }: { base: string; storeName: string }) {
  const path = `${base}/ads/meta/link`;
  const { data, error, setData } = useApi<{ link: ConnectLink | null }>(path);
  const [busy, setBusy] = useState<"make" | "off" | null>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const link = data?.link ?? null;

  const make = async () => {
    setBusy("make");
    setFailed(null);
    setCopied(false);
    try {
      const r = await api<{ link: ConnectLink }>(path, { method: "POST" });
      setData(r);
    } catch (e) {
      setFailed(makeError(e));
    } finally {
      setBusy(null);
    }
  };
  const turnOff = async () => {
    setBusy("off");
    setFailed(null);
    try {
      await api(path, { method: "DELETE" });
      setData({ link: null });
    } catch (e) {
      setFailed(actionError(e, "turn the link off"));
    } finally {
      setBusy(null);
    }
  };
  const copy = async (url: string) => {
    const ok = await navigator.clipboard?.writeText(url).then(
      () => true,
      () => false,
    );
    setCopied(!!ok);
    if (!ok) setFailed("Your browser didn't let bizinsights copy it. Select the link and copy it yourself.");
  };

  return (
    <section aria-labelledby="meta-connect-link-h" className="tone-card flex flex-col gap-3 rounded-xl border p-4 sm:p-5" style={tone("var(--info)")} data-testid="meta-connect-link">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--tone)] text-[var(--surface)]" aria-hidden>
          <Link2 size={18} strokeWidth={2.2} />
        </span>
        <div className="min-w-0">
          <PanelTitle id="meta-connect-link-h">Someone else runs your Meta ads?</PanelTitle>
          <p className="mt-1 text-sm text-muted">
            Send them a link. They sign in with Facebook and choose the ad accounts for {storeName}, without a bizinsights account. bizinsights only reads the
            figures, as when you connect yourself. The link works once and ends after 7 days.
          </p>
        </div>
      </div>
      {failed && <Alert onDismiss={() => setFailed(null)}>{failed}</Alert>}
      {error && !data ? (
        <p className="text-sm text-muted">{actionError(error, "check the store's link")}</p>
      ) : !data ? (
        <div className="skeleton h-10" aria-hidden />
      ) : link ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="input min-w-0 flex-1 basis-64 font-mono text-xs"
              readOnly
              value={link.url}
              aria-label="Connect link"
              onFocus={(e) => e.currentTarget.select()}
              data-testid="meta-connect-link-url"
            />
            <button type="button" className="btn-primary" onClick={() => void copy(link.url)} disabled={!!busy}>
              {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
          <p className="text-xs text-muted">
            Works until {day(link.expiresAt)}
            {link.createdBy ? `, made by ${link.createdBy.you ? "you" : (link.createdBy.name ?? "a member of this workspace")}` : ""}. Anyone holding it can connect
            Meta ad accounts to this store, so send it only to the person who runs your ads.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={() => void make()} disabled={!!busy}>
              {busy === "make" ? "Making…" : "Make a new link"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => void turnOff()} disabled={!!busy} data-testid="meta-connect-link-off">
              {busy === "off" ? "Turning off…" : "Turn off"}
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn-secondary self-start" onClick={() => void make()} disabled={!!busy} data-testid="meta-connect-link-make">
          <Link2 size={15} aria-hidden />
          {busy === "make" ? "Making…" : "Make a connect link"}
        </button>
      )}
    </section>
  );
}
