"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Check, ExternalLink, Lock } from "lucide-react";
import { canManage, useApp } from "@/components/AppContext";
import { Card } from "@/components/PageKit";
import { Alert } from "@/components/ui";
import { DeleteWorkspaceCard } from "@/components/settings/DeleteWorkspaceCard";
import { canOpenPage } from "@/lib/access";
import { actionError, api } from "@/lib/api";

// ---------------------------------------------------------------------------
// Settings → Workspace, as the Stitch design's Business details screen draws it (prototype v2,
// screen 31): the business's name, with its time zone and currency as Shopify gives them (locked:
// they come from the store), where its product costs and its own costs are kept, creating another
// workspace, and deleting this one in the pale red card at the foot. Not drawn: a postal address
// (bizinsights keeps none for the workspace; marketing email's footer address is in Email
// integrations), and the SMS rules, which are Customer Messaging's own settings.
// ---------------------------------------------------------------------------

/** A value that comes from Shopify, shown as the design's locked field. */
function Locked({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="flex min-h-10 items-center justify-between gap-2 rounded bg-home-soft px-3 py-2 text-sm">
        <span className="min-w-0 break-words">{children}</span>
        <Lock aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
      </dd>
    </div>
  );
}

export default function WorkspacePage() {
  const { workspace, me, reloadMe, setWorkspaceId, store, stores, access, offers } = useApp();
  const [name, setName] = useState(workspace.name);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const editable = canManage(workspace.role);
  // Settings pages stay mounted across a workspace switch. Without this the field kept the
  // previous workspace's name, and Save then renamed the newly selected workspace to it.
  useEffect(() => setName(workspace.name), [workspace.id, workspace.name]);
  // Only a switch clears the message: a rename changes the name too, and "Saved." must survive it.
  useEffect(() => setMsg(null), [workspace.id]);
  // Where the store's own costs are kept, for a member who may open those pages (Team & Access).
  const opens = (path: string) => canOpenPage(path, access, workspace.staffRole ?? null, !!me.shared, offers);
  const costsPages = [
    ...(opens("/settings/costs") ? [{ href: "/settings/costs", label: "Settings › Costs" }] : []),
    ...(opens("/profit") ? [{ href: "/profit", label: "Sales › Profit & Loss" }] : []),
  ];

  async function rename(e: FormEvent) {
    e.preventDefault();
    try {
      await api(`/workspaces/${workspace.id}`, { method: "PATCH", body: { name } });
    } catch (err) {
      // Nothing changed, so there is nothing to reload.
      return setMsg(actionError(err, "rename the workspace"));
    }
    setMsg("Saved.");
    await reloadMe();
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    let ws: { id: string };
    try {
      ({ workspace: ws } = await api<{ workspace: { id: string } }>("/workspaces", { method: "POST", body: { name: newName } }));
    } catch (err) {
      return setMsg(actionError(err, "create the workspace"));
    }
    setNewName("");
    // Switch only once `me` lists the new workspace: a `me` from before would pair its id with another
    // workspace's name and role, and the pages would act on that one. Say it was created either way,
    // so it isn't created twice; the /me retry adds it to the workspace menu once bizinsights is back.
    if (!(await reloadMe())) return setMsg(`Created ${newName}. It will appear in the workspace menu as soon as we can reach bizinsights again.`);
    setWorkspaceId(ws.id);
    setMsg(`Created ${newName} and switched to it.`);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Workspace</h1>
        <p className="mt-1 text-sm text-muted sm:text-base">Your business&apos;s details in bizinsights.</p>
      </header>
      {msg && <Alert kind="info">{msg}</Alert>}

      <Card id="business" title="Business details">
        <form onSubmit={rename} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label className="label" htmlFor="ws-name">Name</label>
              <input id="ws-name" className="input" disabled={!editable} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          {store && (
            <dl className="grid gap-4 sm:grid-cols-2">
              <Locked label="Time zone">{store.timezone} · from Shopify</Locked>
              <Locked label="Currency">{store.currency} · from Shopify</Locked>
            </dl>
          )}
          {store && stores.length > 1 && (
            <p className="text-xs text-muted">
              For {store.name ?? store.shopDomain}, the store open at the top: each store keeps its own, as its Shopify admin sets them.
            </p>
          )}
          {editable && (
            <button className="btn-primary">
              <Check aria-hidden className="h-4 w-4" />
              Save
            </button>
          )}
        </form>
        <p className="mt-4 text-sm text-muted">Your role here: {workspace.role}. You belong to {me.workspaces.length} workspace(s).</p>
      </Card>

      {store && (
        <Card id="product-costs" title="Product costs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted">
              bizinsights takes each product&apos;s cost from its cost per item in Shopify. A product without one leaves its cost out of profit, and Home says how much of your sales had none.
            </p>
            <a className="home-btn" href={`https://${store.shopDomain}/admin/products`} target="_blank" rel="noopener noreferrer">
              Add in Shopify
              <ExternalLink aria-hidden className="h-3.5 w-3.5" />
              <span className="sr-only"> (opens Shopify in a new tab)</span>
            </a>
          </div>
        </Card>
      )}

      {costsPages.length > 0 && (
        <Card id="your-costs" title="Your costs">
          <p className="text-sm text-muted">
            The costs Shopify and your ad accounts can&apos;t tell bizinsights (rent, staff, apps, fees), and from which day your list holds every one, are kept in{" "}
            {costsPages.map((p, i) => (
              <span key={p.href}>
                {i > 0 ? " and " : ""}
                <Link className="font-medium text-accent hover:underline" href={p.href}>
                  {p.label}
                </Link>
              </span>
            ))}
            .
          </p>
        </Card>
      )}

      <Card id="create-workspace" title="Create another workspace">
        <p className="text-sm text-muted">Workspaces are fully separate: stores, members and data never mix.</p>
        <form onSubmit={create} className="mt-3 flex gap-2">
          <input aria-label="New workspace name" className="input" required value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn-secondary">Create</button>
        </form>
      </Card>

      <DeleteWorkspaceCard />
    </div>
  );
}
