"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LoadError } from "@/components/LoadError";
import { Alert } from "@/components/ui";
import { ConfirmDialog, Skeleton } from "@/components/AppUi";
import { useApi } from "@/lib/api";
import { publishSecurityStatus, securityStatus } from "@/lib/accountSecurity";
import { authErrorMessage, leaveTo, signOutEverywhere, type AccountInfo } from "@/lib/auth";
import { ActivityCard } from "./security/ActivityCard";
import { DeleteCard } from "./security/DeleteCard";
import { DevicesCard, useDevices } from "./security/DevicesCard";
import { EmailCard } from "./security/EmailCard";
import { MethodsCard } from "./security/MethodsCard";
import { PasswordCard } from "./security/PasswordCard";
import { SignOutCard } from "./security/SignOutCard";
import { StatusCard } from "./security/StatusCard";
import { TwoStepCard } from "./security/TwoStepCard";

/**
 * Account security, for merchants (Settings → Security) and employees (the portal's Account page):
 * how protected the account is; its email, password and two-step verification; the devices it is
 * signed in on (any of which can be signed out from here) and how it signs in; its recent sign-ins;
 * signing out here or everywhere; and deleting it. Every change goes through the API to Cognito.
 * The cards are in ./security/, a file each.
 */
export function AccountSecurity({ title = "Security", intro, heading = "h1" }: { title?: string; intro?: string; heading?: "h1" | "h2" }) {
  const router = useRouter();
  const q = useApi<AccountInfo>("/auth/account");
  const devices = useDevices();
  const a = q.data;
  const [notice, setNotice] = useState<string | null>(null);
  const [twoStepOpen, setTwoStepOpen] = useState(false);
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [allError, setAllError] = useState<string | null>(null);
  const reload = () => void q.reload();
  const cancelAll = useCallback(() => setConfirmAll(false), []);
  const status = a ? securityStatus(a) : null;

  // The settings menu's "Account security" card shows what this page found.
  useEffect(() => {
    if (a) publishSecurityStatus(securityStatus(a));
  }, [a]);

  /** A change went through: say so at the top, and show the account (and its devices) as they are now. */
  const changed = (text: string) => {
    setNotice(text);
    void q.reload();
    void devices.reload();
  };

  function openStatus() {
    if (!status) return;
    if (status.fix === "email") return router.push("/verify-email");
    if (status.fix === "twoStep") return setTwoStepOpen(true);
    if (status.tone === "warn") setActivityExpanded(true);
    document.getElementById("sign-in-activity")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function everywhere() {
    setLeaving(true);
    setAllError(null);
    try {
      leaveTo(await signOutEverywhere(), router);
    } catch (err) {
      setAllError(authErrorMessage(err));
      setLeaving(false);
      setConfirmAll(false);
    }
  }

  const Heading = heading;
  const provider = a?.signedInWith === "google" ? "Google" : null;

  return (
    <div className="@container space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 pt-1">
          {/* As a page of its own (Settings → Security), the Stitch design's page title. */}
          <Heading className={heading === "h1" ? "page-title" : "text-xl font-semibold"}>{title}</Heading>
          <p className="mt-1 text-sm text-muted">{intro ?? "Manage your account security, connected devices, and sign-in activity."}</p>
        </div>
        {status && <StatusCard status={status} onOpen={openStatus} />}
      </div>

      {notice && (
        <Alert kind="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {allError && (
        <Alert kind="error" onDismiss={() => setAllError(null)}>
          {allError}
        </Alert>
      )}

      {q.error && !a ? (
        <LoadError what="your account" error={q.error} onRetry={reload} busy={q.loading} />
      ) : !a ? (
        <Skeleton lines={5} />
      ) : (
        <>
          <div className="grid gap-4 @3xl:grid-cols-2 @3xl:[&>*:last-child]:col-span-2 @5xl:grid-cols-3 @5xl:[&>*:last-child]:col-span-1">
            <EmailCard account={a} provider={provider} onChanged={changed} />
            <PasswordCard account={a} provider={provider} onChanged={changed} />
            <TwoStepCard account={a} open={twoStepOpen} onOpen={() => setTwoStepOpen(true)} onClose={() => setTwoStepOpen(false)} onChanged={changed} onRetry={reload} />
          </div>
          <DevicesCard q={devices} onSignOutAll={() => setConfirmAll(true)} />
          <MethodsCard account={a} onChanged={reload} />
          <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <ActivityCard expanded={activityExpanded} onExpanded={setActivityExpanded} />
            <div className="grid gap-4">
              <SignOutCard onSignOutAll={() => setConfirmAll(true)} />
              <DeleteCard />
            </div>
          </div>
        </>
      )}

      <ConfirmDialog open={confirmAll} title="Sign out of all devices?" confirmLabel="Sign out everywhere" danger busy={leaving} onCancel={cancelAll} onConfirm={() => void everywhere()}>
        <p>Every browser and phone signed in to your account will be signed out, including this one.</p>
      </ConfirmDialog>
    </div>
  );
}
