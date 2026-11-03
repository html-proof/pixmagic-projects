"use client";
import { useEffect, useState, type FormEvent } from "react";
import { canManage, useApp } from "@/components/AppContext";
import { Alert } from "@/components/ui";
import { DeleteWorkspaceCard } from "@/components/settings/DeleteWorkspaceCard";
import { actionError, api } from "@/lib/api";

export default function WorkspacePage() {
  const { workspace, me, reloadMe, setWorkspaceId } = useApp();
  const [name, setName] = useState(workspace.name);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const editable = canManage(workspace.role);
  // Settings pages stay mounted across a workspace switch. Without this the field kept the
  // previous workspace's name, and Save then renamed the newly selected workspace to it.
  useEffect(() => setName(workspace.name), [workspace.id, workspace.name]);
  // Only a switch clears the message: a rename changes the name too, and "Saved." must survive it.
  useEffect(() => setMsg(null), [workspace.id]);

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
    <>
      <section className="card space-y-3">
        <h1 className="text-lg font-semibold">Workspace</h1>
        {msg && <Alert kind="info">{msg}</Alert>}
        <form onSubmit={rename} className="space-y-3">
          <label className="label" htmlFor="ws-name">Name</label>
          <input id="ws-name" className="input" disabled={!editable} value={name} onChange={(e) => setName(e.target.value)} />
          {editable && <button className="btn-primary">Save</button>}
        </form>
        <p className="text-sm text-muted">Your role here: {workspace.role}. You belong to {me.workspaces.length} workspace(s).</p>
      </section>
      <section className="card space-y-3">
        <h2 className="font-semibold">Create another workspace</h2>
        <p className="text-sm text-muted">Workspaces are fully separate: stores, members and data never mix.</p>
        <form onSubmit={create} className="flex gap-2">
          <input aria-label="New workspace name" className="input" required value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className="btn-secondary">Create</button>
        </form>
      </section>
      <DeleteWorkspaceCard />
    </>
  );
}
