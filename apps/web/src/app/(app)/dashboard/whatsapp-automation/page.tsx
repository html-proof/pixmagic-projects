"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { canManage, StoresPending, useApp } from "@/components/AppContext";
import { SectionLayout, Skeleton } from "@/components/AppUi";
import { LoadError } from "@/components/LoadError";
import { Badge } from "@/components/dashboard/Primitives";
import { useApi } from "@/lib/api";
import { Automations } from "@/components/whatsapp/Automations";
import { Campaigns } from "@/components/whatsapp/Campaigns";
import { Customers } from "@/components/whatsapp/Customers";
import { Messages } from "@/components/whatsapp/Messages";
import { Overview } from "@/components/whatsapp/Overview";
import { Settings } from "@/components/whatsapp/Settings";
import { Setup } from "@/components/whatsapp/Setup";
import { Templates } from "@/components/whatsapp/Templates";
import type { WaOverview } from "@/components/whatsapp/types";
import { CONNECTION_TONE, useWa, waHref, WhatsappIcon } from "@/components/whatsapp/WaUi";

// WhatsApp Automation (docs/whatsapp.md): one page, its tabs in ?tab=. The page keeps the routing and
// the overview every tab shares; each tab is a component in components/whatsapp/.

const TABS = [
  ["overview", "Overview"],
  ["setup", "Setup"],
  ["messages", "Messages"],
  ["automations", "Automations"],
  ["templates", "Templates"],
  ["campaigns", "Campaigns"],
  ["customers", "Customers"],
  ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function WhatsappAutomationPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} />}>
      <WhatsappAutomation />
    </Suspense>
  );
}

function WhatsappAutomation() {
  const params = useSearchParams();
  const { storesStatus, store, workspace } = useApp();
  const { base } = useWa();
  const overview = useApi<WaOverview>(base);
  const data = overview.data;
  const tabs = TABS.filter(([key]) => key !== "customers" || data?.can.contacts);
  const asked = params.get("tab");
  // Without ?tab=, the page opens on the setup until its four steps are done, else the overview: chosen
  // once per store, so finishing a step (which reloads the overview) doesn't move the page away.
  const [opened, setOpened] = useState<{ base: string; tab: Tab } | null>(null);
  if (data && base && opened?.base !== base) setOpened({ base, tab: data.setup.current ? "setup" : "overview" });
  const fallback: Tab = opened?.base === base ? opened.tab : data?.setup.current ? "setup" : "overview";
  const tab: Tab = tabs.some(([key]) => key === asked) ? (asked as Tab) : fallback;
  const items = tabs.map(([key, label]) => ({ href: waHref(key), label, active: key === tab }));
  const title = "WhatsApp Automation";

  let body;
  if (storesStatus !== "ready") body = <StoresPending />;
  else if (!store || !base)
    body = (
      <div className="home-card animate-rise p-5 sm:p-6">
        <h1 className="card-title">{title}</h1>
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
    const conn = data.connection && data.connection.status !== "disconnected" ? data.connection : null;
    body = (
      <>
        {/* The page's header as the Stitch design heads Marketing (screens 14–18): the title, one line, and the connection's one status word on the right. */}
        <div className="animate-rise pb-1">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="min-w-0">
              <h1 className="page-title flex items-center gap-2">
                <WhatsappIcon size={22} /> {title}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {conn
                  ? `Automated and personal WhatsApp messages for ${data.store.name}${conn.phone ? `, from ${conn.phone}` : ""}.`
                  : `Connect ${data.store.name}'s WhatsApp to message customers about their orders, automatically and safely.`}
              </p>
            </div>
            {conn ? (
              <Badge tone={CONNECTION_TONE[conn.status] ?? "neutral"}>{conn.statusLabel}</Badge>
            ) : (
              <Link href={waHref("setup")} className="btn-primary h-10">
                <WhatsappIcon size={18} /> Connect WhatsApp
              </Link>
            )}
          </div>
        </div>
        {tab === "overview" && <Overview base={base} overview={data} reload={reload} />}
        {tab === "setup" && <Setup base={base} overview={data} reload={reload} />}
        {tab === "messages" && <Messages base={base} overview={data} />}
        {tab === "automations" && <Automations base={base} overview={data} reload={reload} />}
        {tab === "templates" && <Templates base={base} overview={data} reload={reload} />}
        {tab === "campaigns" && <Campaigns base={base} overview={data} />}
        {tab === "customers" && <Customers base={base} overview={data} />}
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
