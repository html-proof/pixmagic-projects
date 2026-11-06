"use client";
import { useState } from "react";
import { ConfirmDialog } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Card } from "@/components/PageKit";
import { Badge } from "@/components/dashboard/Primitives";
import { api, useApi } from "@/lib/api";
import { COUNTRY_CHOICES, countryName, useSms, useSmsAction } from "./MessagingUi";
import type { SmsMode, TestNumber } from "./types";

/**
 * Test recipients: the team's own phones. While the SMS account is being verified (the provider's
 * sandbox) texts only reach numbers approved with a code the provider texts them, typed in here.
 * Owners and admins only. A white card of the Stitch design (components/PageKit.tsx), its numbers
 * as rows with hairlines between them.
 */
export function TestNumbers({ mode }: { mode: SmsMode }) {
  const { base } = useSms();
  const { data, error, reload, loading } = useApi<{ testNumbers: TestNumber[] }>(base ? `${base}/test-numbers` : null);
  const { busy, run } = useSmsAction();
  const [number, setNumber] = useState("");
  const [country, setCountry] = useState("");
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<TestNumber | null>(null);
  const add = () =>
    run("add", "add the test number", async () => {
      await api(`${base}/test-numbers`, { method: "POST", body: { number: number.trim(), country: country || null } });
      setNumber("");
      await reload();
      return "We're texting a code to that number. Type it in below.";
    });
  const verify = (t: TestNumber) =>
    run(`verify:${t.id}`, "check the code", async () => {
      await api(`${base}/test-numbers/${t.id}/verify`, { method: "POST", body: { code: (codes[t.id] ?? "").trim() } });
      setCodes({ ...codes, [t.id]: "" });
      await reload();
      return "Approved. Test messages can go to this number now.";
    });
  const resend = (t: TestNumber) =>
    run(`resend:${t.id}`, "send a new code", async () => {
      await api(`${base}/test-numbers/${t.id}/resend`, { method: "POST", body: {} });
      return "A new code is on its way.";
    });
  return (
    <Card id="test-recipients" title="Test recipients" className="scroll-mt-4">
      <p className="text-sm text-muted">
        Your team&apos;s own mobiles, for test messages. {mode === "sandbox" ? "While your SMS account is being verified, these are the only numbers that can receive texts." : ""} Each is approved with a code we text to it. Up to 5 per store.
      </p>
      {mode === "off" && <p className="mt-2 text-sm text-muted">No code can be texted while SMS isn&apos;t available for your account.</p>}
      {error ? (
        <div className="mt-3">
          <LoadError what="the test numbers" error={error} onRetry={() => void reload()} busy={loading} />
        </div>
      ) : !data ? (
        <div className="skeleton mt-3 h-16" />
      ) : (
        <>
          {data.testNumbers.length > 0 && (
            <ul className="mt-3 divide-y divide-home-line border-y border-home-line">
              {data.testNumbers.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="font-mono text-sm">{t.number}</span>
                  <span className="text-xs text-muted">{countryName(t.country)}</span>
                  <Badge tone={t.status === "verified" ? "good" : "warn"}>{t.status === "verified" ? "Approved" : "Waiting for the code"}</Badge>
                  <span className="flex-1" />
                  {t.status !== "verified" && (
                    <span className="flex flex-wrap items-center gap-2">
                      <label className="sr-only" htmlFor={`code-${t.id}`}>
                        Code we texted to {t.number}
                      </label>
                      <input
                        id={`code-${t.id}`}
                        className="input h-8 w-28 py-1 font-mono"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={10}
                        placeholder="Code"
                        value={codes[t.id] ?? ""}
                        onChange={(e) => setCodes({ ...codes, [t.id]: e.target.value.replace(/\D/g, "") })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (codes[t.id] ?? "").length >= 4) void verify(t);
                        }}
                      />
                      <button type="button" className="btn-primary h-8 px-3 text-xs" disabled={!!busy || (codes[t.id] ?? "").length < 4} onClick={() => void verify(t)}>
                        Approve
                      </button>
                      <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => void resend(t)}>
                        New code
                      </button>
                    </span>
                  )}
                  <button type="button" className="btn-secondary h-8 px-3 text-xs" disabled={!!busy} onClick={() => setRemoving(t)} aria-label={`Remove ${t.number}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {data.testNumbers.length < 5 && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (number.trim().length >= 6) void add();
              }}
            >
              <div className="w-full min-w-0 sm:w-56">
                <label className="text-xs text-muted" htmlFor="tn-number">
                  Mobile number, with its country code
                </label>
                <input id="tn-number" className="input" type="tel" autoComplete="off" placeholder="+61 412 345 678" value={number} onChange={(e) => setNumber(e.target.value)} />
              </div>
              <div className="w-full min-w-0 sm:w-44">
                <label className="text-xs text-muted" htmlFor="tn-country">
                  Country (if no +code)
                </label>
                <select id="tn-country" className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                  <option value="">From the number</option>
                  {COUNTRY_CHOICES.map((c) => (
                    <option key={c} value={c}>
                      {countryName(c)}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-secondary" disabled={!!busy || number.trim().length < 6 || mode === "off"}>
                {busy === "add" ? "Texting a code…" : "Add and text a code"}
              </button>
            </form>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!removing}
        title={`Remove ${removing?.number ?? ""}?`}
        confirmLabel="Remove"
        danger
        busy={!!busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          void run("remove", "remove the test number", async () => {
            await api(`${base}/test-numbers/${removing!.id}`, { method: "DELETE" });
            setRemoving(null);
            await reload();
            return "Removed.";
          })
        }
      >
        <p>It can&apos;t receive test messages any more. You can add it again later with a new code.</p>
      </ConfirmDialog>
    </Card>
  );
}
