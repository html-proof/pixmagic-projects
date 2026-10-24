"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { useApi } from "@/lib/api";
import { Activity } from "@/components/whatsapp/Activity";
import { Campaigns } from "@/components/whatsapp/Campaigns";
import { Contacts } from "@/components/whatsapp/Contacts";
import { Onboarding, Overview } from "@/components/whatsapp/Overview";
import { Settings } from "@/components/whatsapp/Settings";
import { Templates } from "@/components/whatsapp/Templates";
import { Workflows } from "@/components/whatsapp/Workflows";
import type { WaOverview } from "@/components/whatsapp/types";
import { useWa, waHref, WhatsappIcon } from "@/components/whatsapp/WaUi";

// WhatsApp Automation (docs/whatsapp.md): one page, its tabs in ?tab=. The page keeps the routing
// and the overview everyone shares; each tab is a component in components/whatsapp/.

const TABS = [
  ["overview", "Overview"],
  ["templates", "Message templates"],
  ["workflows", "Automated workflows"],
  ["campaigns", "Campaigns"],
  ["activity", "Message history"],
  ["contacts", "Customers"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function WhatsappPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <WhatsappAutomation />
    </Suspense>
  );
}

function WhatsappAutomation() {
  const params = useSearchParams();
  const asked = params.get("tab");
  const { storesStatus, store, workspace } = useApp();
  const { base } = useWa();
  const overview = useApi<WaOverview>(base);
  const data = overview.data;
  const connected = !!data?.connection && data.connection.status !== "disconnected";
  // Not connected: the onboarding, and the history of an earlier connection.
  const tabs = TABS.filter(([key]) => (connected ? key !== "contacts" || data?.can.contacts : key === "overview" || (key === "activity" && data?.connection)));
  const tab: Tab = tabs.some(([key]) => key === asked) ? (asked as Tab) : "overview";
  const items = tabs.map(([key, label]) => ({ href: waHref(key), label, active: key === tab }));
  const title = "WhatsApp Automation";

  let body;
  if (storesStatus !== "ready") body = <StoresPending />;
  else if (!store || !base)
    body = (
      <div className="card">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">Connect a Shopify store first: WhatsApp messages are about a store&apos;s orders and customers.</p>
        {canManage(workspace.role) && (
          <Link href="/onboarding" className="btn-primary mt-3 inline-flex">
            Connect a store
          </Link>
        )}
      </div>
    );
  else if (overview.error) body = <LoadError what="WhatsApp Automation" error={overview.error} onRetry={() => void overview.reload()} busy={overview.loading} />;
  else if (!data) body = <Skeleton lines={6} />;
  else {
    const reload = () => void overview.reload();
    body = (
      <>
        <div className="card animate-rise">
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <WhatsappIcon size={22} /> {title}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {connected
              ? `Automated and personal WhatsApp messages for ${data.store.name}, from ${data.connection!.displayPhoneNumber ?? "your WhatsApp Business number"}.`
              : `Connect ${data.store.name}'s WhatsApp Business number to message customers automatically.`}
          </p>
        </div>
        {tab === "overview" && (connected ? <Overview data={data} base={base} reload={reload} /> : <Onboarding data={data} base={base} onConnected={reload} />)}
        {tab === "templates" && <Templates base={base} overview={data} />}
        {tab === "workflows" && <Workflows base={base} overview={data} />}
        {tab === "campaigns" && <Campaigns base={base} overview={data} />}
        {tab === "activity" && <Activity base={base} overview={data} />}
        {tab === "contacts" && <Contacts base={base} overview={data} />}
        {tab === "settings" && <Settings base={base} overview={data} reload={reload} />}
      </>
    );
  }
  return (
    <SectionLayout title="WhatsApp" icon={<WhatsappIcon size={18} />} items={items}>
      {body}
    </SectionLayout>
  );
}
