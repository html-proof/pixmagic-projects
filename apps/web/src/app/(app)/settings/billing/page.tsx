"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { can } from "@app/shared/roles";
import { useApp } from "@/components/AppContext";
import { ConfirmDialog } from "@/components/AppUi";
import { Alert } from "@/components/ui";
import { ErrorState } from "@/components/ErrorState";
import { LoadError } from "@/components/LoadError";
import { actionError, api, useApi } from "@/lib/api";
import { BILLING_PAGE } from "@/lib/features";

interface Plan {
  id: string;
  name: string;
  priceUsd: number;
  features: string[];
}

interface Billing {
  /**
   * `plan` is the plan in force; `pendingPlan` a change still awaiting approval in Shopify;
   * `billedStore` the store whose Shopify bill carries the charges, while there are any.
   */
  subscription: { plan: string; status: string; pendingPlan?: string | null; billedStore?: { id: string; shopDomain: string; name: string | null } | null };
  plans: Plan[];
}

export default function BillingPage() {
  return BILLING_PAGE ? <BillingPlans /> : <BillingHidden />;
}

/** Billing is switched off (see `lib/features.ts`): an old link or bookmark lands on Settings instead. */
function BillingHidden() {
  const router = useRouter();
  useEffect(() => router.replace("/settings/profile"), [router]);
  return null;
}

function BillingPlans() {
  const { workspace, store, storesStatus } = useApp();
  const { data, error: loadError, loading, reload } = useApi<Billing>(`/workspaces/${workspace.id}/billing`);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [paymentFailed, setPaymentFailed] = useState(false);
  const [confirmFree, setConfirmFree] = useState(false);
  const [busy, setBusy] = useState(false);
  const isOwner = can(workspace.role, "billing:manage");
  // Shopify sends the merchant back here after the approval screen; the plan itself changes when
  // Shopify confirms the charge (a webhook), which can land a few seconds after they arrive.
  const [returned, setReturned] = useState(false);
  useEffect(() => setReturned(new URLSearchParams(window.location.search).get("confirmed") === "1"), []);
  const planOf = (id: string) => data?.plans.find((p) => p.id === id);
  const planName = (id: string) => planOf(id)?.name ?? id;
  const sub = data?.subscription;
  const current = sub ? planOf(sub.plan) : undefined;
  const billedTo = sub?.billedStore ? sub.billedStore.name || sub.billedStore.shopDomain : null;

  async function choose(plan: string) {
    setError(null);
    // No store yet is only true once the list has loaded; before that we just don't know which one.
    if (!store && storesStatus !== "ready") return setError("Your stores haven't loaded yet. Please try again in a moment.");
    if (!store) return setError("Connect a store first. Plans are billed through your Shopify invoice.");
    try {
      const { confirmationUrl } = await api<{ confirmationUrl: string }>(`/workspaces/${workspace.id}/billing/subscribe`, { method: "POST", body: { plan, storeId: store.id } });
      window.location.assign(confirmationUrl);
    } catch (e) {
      setPaymentFailed(true);
      setError(actionError(e, "start the plan change"));
    }
  }

  async function switchToFree() {
    setBusy(true);
    setError(null);
    try {
      const { plan } = await api<{ plan: string }>(`/workspaces/${workspace.id}/billing/cancel`, { method: "POST", body: {} });
      setConfirmFree(false);
      setNotice(
        plan === "free"
          ? "You're on the Free plan now. Shopify has stopped the subscription and credits the days you didn't use."
          : `Shopify has stopped renewing ${planName(plan)}; you move to Free when its billing period ends.`,
      );
      await reload();
    } catch (e) {
      setPaymentFailed(true);
      setError(actionError(e, "switch to Free"));
    } finally {
      setBusy(false);
    }
  }

  /** The button on a plan's card: none for the plan in force, or for someone who can't change it. */
  function action(p: Plan) {
    if (!sub || !current || sub.plan === p.id || !isOwner) return null;
    if (p.id === "free") {
      return (
        <button className="btn-secondary w-full" onClick={() => setConfirmFree(true)}>
          Switch to Free
        </button>
      );
    }
    const label = sub.pendingPlan === p.id ? `Approve ${p.name} in Shopify` : p.priceUsd > current.priceUsd ? `Upgrade to ${p.name}` : `Switch to ${p.name}`;
    return (
      <button className="btn-primary w-full" onClick={() => void choose(p.id)}>
        {label}
      </button>
    );
  }

  if (paymentFailed) return <ErrorState kind="payment" action={<button type="button" className="btn-primary" disabled={loading} onClick={async () => { if (await reload()) { setPaymentFailed(false); setError(null); } }}>Check billing status</button>} />;

  return (
    <section className="space-y-4">
      <h1 className="text-lg font-semibold">Billing</h1>
      {!data && loadError ? (
        <LoadError what="your plan" error={loadError} onRetry={() => void reload()} busy={loading} />
      ) : (
        <p className="text-sm text-muted">
          Current plan: <strong className="text-text">{sub ? planName(sub.plan) : "…"}</strong>
          {sub && sub.status !== "active" ? ` (${sub.status})` : ""}.{" "}
          {billedTo ? `Charges appear on the Shopify bill of ${billedTo}.` : "A paid plan is charged on the Shopify bill of the store you have open."}
        </p>
      )}
      {sub?.pendingPlan && (
        <Alert kind="info">
          {returned
            ? `Thanks. Shopify is confirming your change to ${planName(sub.pendingPlan)}; this page shows it once Shopify reports it, usually within a minute.`
            : `A change to ${planName(sub.pendingPlan)} is waiting for approval in Shopify. Choose it again to reopen the approval page.`}
        </Alert>
      )}
      {notice && (
        <Alert kind="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-3">
        {data?.plans.map((p) => (
          <div key={p.id} className={`card space-y-2 ${data.subscription.plan === p.id ? "border-accent" : ""}`} aria-current={data.subscription.plan === p.id ? "true" : undefined}>
            <p className="font-semibold">{p.name}</p>
            <p className="text-2xl font-semibold">
              ${p.priceUsd}
              <span className="text-sm font-normal text-muted">/month</span>
            </p>
            <ul className="space-y-1 text-sm text-muted">
              {p.features.map((f) => (
                <li key={f}>• {f}</li>
              ))}
            </ul>
            {action(p)}
          </div>
        ))}
      </div>
      {!isOwner && <p className="text-xs text-muted">Only workspace owners can change the plan.</p>}
      <ConfirmDialog
        open={confirmFree}
        title="Switch to Free?"
        confirmLabel="Switch to Free"
        danger
        busy={busy}
        onConfirm={() => void switchToFree()}
        onCancel={() => setConfirmFree(false)}
      >
        <p>
          Your {current?.name ?? "paid"} subscription is cancelled in Shopify now{billedTo ? ` (on the bill of ${billedTo})` : ""}, with a credit for the days left
          in this billing period, and the workspace moves to Free straight away.
        </p>
        <p>You can choose a paid plan again at any time.</p>
      </ConfirmDialog>
    </section>
  );
}
