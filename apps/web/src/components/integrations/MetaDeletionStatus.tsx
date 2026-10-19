"use client";
import { useEffect, useState } from "react";

/** Codes bizinsights hands Facebook (letters, digits, - and _); anything else is never sent to the API. */
const CODE = /^[A-Za-z0-9_-]{4,100}$/;

type Answer = { status: "done" | "unknown"; at?: string };

const longDate = (iso: string) => new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));

/**
 * /data-deletion?code=<confirmation code>: where Facebook's data deletion request sends the person
 * (the `url` bizinsights answered POST /webhooks/meta/data-deletion with). Shows that request's status
 * from GET /api/meta/data-deletion/:code; without a code, nothing.
 */
export function MetaDeletionStatus() {
  const [code, setCode] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState<"bad_code" | "unreachable" | null>(null);

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("code");
    if (c === null) return;
    setCode(c);
    if (!CODE.test(c)) return setFailed("bad_code");
    let live = true;
    // A plain fetch, not lib/api: a public legal page carries none of the signed-in app's code.
    fetch(`/api/meta/data-deletion/${encodeURIComponent(c)}`, { credentials: "omit" })
      .then(async (res) => {
        if (!live) return;
        // A code the API doesn't know is a 200 "unknown". A 404 is a route that isn't there (not
        // deployed, or not routed): it says nothing about the request, so it's "couldn't check".
        if (res.status === 400) return setFailed("bad_code");
        if (!res.ok) return setFailed("unreachable");
        const a = (await res.json()) as Partial<Answer>;
        if (!live) return;
        if (a.status === "done" || a.status === "unknown") setAnswer({ status: a.status, at: typeof a.at === "string" && !Number.isNaN(Date.parse(a.at)) ? a.at : undefined });
        else setFailed("unreachable");
      })
      .catch(() => live && setFailed("unreachable"));
    return () => {
      live = false;
    };
  }, []);

  if (code === null) return null;
  const text =
    failed === "bad_code"
      ? `"${code}" isn't a confirmation code bizinsights gives. Check the code Facebook showed you, or email us and we'll look it up.`
      : failed === "unreachable"
        ? `We couldn't check deletion request ${code} just now. Please reload this page in a moment.`
        : !answer
          ? `Checking deletion request ${code}…`
          : answer.status === "done"
            ? `Deletion request ${code} is done${answer.at ? `: completed on ${longDate(answer.at)}` : ""}. bizinsights deleted the Meta Ads figures and the access it held for the Facebook login that sent it, and no longer reads from it.`
            : `We have no deletion request with the code ${code}. Check the code Facebook showed you, or email us and we'll look it up.`;
  const done = answer?.status === "done";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="deletion-status"
      className={`mt-5 rounded-xl border px-4 py-3 text-sm text-text ${done ? "border-[color-mix(in_oklab,var(--good)_40%,var(--border))]" : "border-border"} bg-surface`}
    >
      <p className="font-semibold">{done ? "Deletion complete" : "Your Meta data deletion request"}</p>
      <p className="mt-1 text-muted">{text}</p>
    </div>
  );
}
