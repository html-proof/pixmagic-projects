"use client";
import { useId, useMemo, useState } from "react";
import { ChevronDown, Search, ShieldAlert } from "lucide-react";
import { ACCESS_MODULE_INFO, addPermission, isAccessKey, removePermission, roleAllowsKind, isRestrictedRole, type AccessKey, type AccessModule } from "@app/shared/access";
import type { Role } from "@app/shared/roles";
import type { StaffRole } from "@app/shared/staff";
import type { Catalog, CatalogPermission } from "@/lib/team";

export interface AccessDraft {
  role: Role;
  permissions: Set<AccessKey>;
  staffRole: StaffRole | null;
}

/** The modules a draft has anything in, in catalog order. */
export function draftModules(catalog: Catalog, d: AccessDraft): AccessModule[] {
  if (!isRestrictedRole(d.role)) return catalog.modules.map((m) => m.id);
  return catalog.modules.filter((m) => m.permissions.some((p) => d.permissions.has(p.key as AccessKey))).map((m) => m.id);
}

/** "Selected Access: 3 Modules — Customer details • Product details • Marketing". */
export function AccessSummary({ catalog, draft }: { catalog: Catalog; draft: AccessDraft }) {
  const restricted = isRestrictedRole(draft.role);
  const modules = draftModules(catalog, draft);
  return (
    <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3" aria-live="polite" data-testid="access-summary">
      <p className="text-sm font-semibold">
        {restricted ? `Selected Access: ${modules.length} ${modules.length === 1 ? "Module" : "Modules"}` : "Full access"}
        {restricted && <span className="ml-2 text-xs font-normal text-muted">{draft.permissions.size} permission{draft.permissions.size === 1 ? "" : "s"}</span>}
      </p>
      <p className="mt-0.5 text-sm text-muted">
        {restricted ? (modules.length ? modules.map((m) => ACCESS_MODULE_INFO[m].label).join(" • ") : "Nothing yet: tick what this person may see below.") : "Everything in the workspace, including managing the team."}
      </p>
    </div>
  );
}

function KindBadge({ p }: { p: CatalogPermission }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {p.sensitive && <span className="rounded-full bg-warn/12 px-1.5 py-px text-[11px] font-medium text-warn">Sensitive</span>}
      {p.kind === "manage" && <span className="rounded-full bg-accent/10 px-1.5 py-px text-[11px] font-medium text-accent">Makes changes</span>}
      {p.kind === "export" && <span className="rounded-full bg-info/10 px-1.5 py-px text-[11px] font-medium text-info">Download</span>}
    </span>
  );
}

/**
 * Choosing a role and what it may see: the role's template ticks its permissions to start with, and
 * each module can be opened to change them one by one. Sensitive permissions (customers' personal
 * details, finance, payroll, managing anything, exports) are never part of a template, and "Select
 * all" leaves them for the owner or admin to tick themselves. The API checks the result again.
 */
export function PermissionEditor({
  catalog,
  draft,
  onChange,
  roles,
  readOnly = false,
}: {
  catalog: Catalog;
  draft: AccessDraft;
  onChange(d: AccessDraft): void;
  /** The roles that may be picked (an admin can't make an owner). */
  roles: Catalog["roles"];
  readOnly?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  // Read-only, the modules with something granted start open, so what is shared is in view.
  const [open, setOpen] = useState<Set<string>>(() => new Set(readOnly ? catalog.modules.filter((m) => m.permissions.some((p) => draft.permissions.has(p.key as AccessKey))).map((m) => m.id) : []));
  const restricted = isRestrictedRole(draft.role);
  const q = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      catalog.modules
        .map((m) => ({
          ...m,
          shown: q ? m.permissions.filter((p) => `${p.label} ${p.reveals} ${m.label}`.toLowerCase().includes(q)) : m.permissions,
        }))
        .filter((m) => m.shown.length > 0),
    [catalog.modules, q],
  );

  const set = (permissions: Set<AccessKey>) => onChange({ ...draft, permissions });
  const can = (p: CatalogPermission) => restricted && isRestrictedRole(draft.role) && roleAllowsKind(draft.role, p.kind);
  const toggle = (p: CatalogPermission, on: boolean) => {
    if (!isAccessKey(p.key)) return;
    set(on ? addPermission(draft.permissions, p.key) : removePermission(draft.permissions, p.key));
  };
  const selectAll = (perms: CatalogPermission[]) => {
    let next = new Set(draft.permissions);
    for (const p of perms) if (!p.sensitive && can(p) && isAccessKey(p.key)) next = addPermission(next, p.key);
    set(next);
  };
  const deselectAll = (perms: CatalogPermission[]) => {
    let next = new Set(draft.permissions);
    for (const p of perms) if (isAccessKey(p.key)) next = removePermission(next, p.key);
    set(next);
  };
  const pickRole = (role: Role) => {
    const r = roles.find((x) => x.id === role);
    if (!r) return;
    const template = new Set(r.restricted ? r.template.filter(isAccessKey) : []);
    onChange({ role, permissions: template, staffRole: r.restricted ? draft.staffRole : null });
  };
  const staffTicked = [...draft.permissions].some((k) => k.startsWith("staff."));

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="label">Role</legend>
        <p className="mb-2 text-xs text-muted">A role is a starting point: it ticks the permissions below, which you can then change. Nobody gets more than what&apos;s ticked.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {roles.map((r) => {
            const checked = draft.role === r.id;
            return (
              <label
                key={r.id}
                className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm transition-colors focus-within:ring-2 focus-within:ring-accent ${checked ? "border-accent bg-accent/[0.06]" : "border-border hover:border-accent/40"} ${readOnly ? "pointer-events-none opacity-80" : ""}`}
              >
                <input type="radio" name={`${id}-role`} value={r.id} checked={checked} onChange={() => pickRole(r.id)} disabled={readOnly} className="mt-0.5 accent-[var(--accent)]" />
                <span className="min-w-0">
                  <span className="block font-semibold">{r.label}</span>
                  <span className="block text-xs text-muted">{r.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <AccessSummary catalog={catalog} draft={draft} />

      {restricted && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input type="search" aria-label="Search permissions" placeholder="Search permissions" className="input pl-9" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => setOpen(new Set(catalog.modules.map((m) => m.id)))}>
              Expand all
            </button>
            <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => setOpen(new Set())}>
              Collapse all
            </button>
          </div>
          {!catalog.hasStore && <p className="text-xs text-muted">No store is connected yet: what each permission shows appears once one is.</p>}
          {visible.length === 0 && <p className="text-sm text-muted">No permission matches &ldquo;{query}&rdquo;.</p>}
          <ul className="space-y-2">
            {visible.map((m) => {
              const expanded = !!q || open.has(m.id);
              const picked = m.permissions.filter((p) => draft.permissions.has(p.key as AccessKey)).length;
              const panel = `${id}-${m.id}`;
              return (
                <li key={m.id} className="rounded-xl border border-border" data-testid={`module-${m.id}`}>
                  <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panel}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setOpen((o) => {
                        const next = new Set(o);
                        if (next.has(m.id)) next.delete(m.id);
                        else next.add(m.id);
                        return next;
                      })}
                    >
                      <ChevronDown aria-hidden className={`h-4 w-4 shrink-0 text-muted transition-transform ${expanded ? "rotate-180" : ""}`} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold">{m.label}</span>
                        <span className="block truncate text-xs text-muted">{m.description}</span>
                      </span>
                    </button>
                    <span className={`text-xs ${picked ? "font-medium text-accent" : "text-muted"}`}>
                      {picked} of {m.permissions.length}
                    </span>
                    {!readOnly && (
                      <span className="flex gap-1">
                        <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10" onClick={() => selectAll(m.permissions)} aria-label={`Select all in ${m.label}`}>
                          Select all
                        </button>
                        <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-text/[0.05]" onClick={() => deselectAll(m.permissions)} aria-label={`Deselect all in ${m.label}`}>
                          Deselect all
                        </button>
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <div id={panel} className="border-t border-border px-3 py-2">
                      <ul className="divide-y divide-border">
                        {m.shown.map((p) => {
                          const checked = draft.permissions.has(p.key as AccessKey);
                          const allowedForRole = can(p);
                          return (
                            <li key={p.key} className="py-2">
                              <label className={`flex gap-3 text-sm ${allowedForRole && !readOnly ? "cursor-pointer" : "cursor-not-allowed"}`}>
                                <input
                                  type="checkbox"
                                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                                  checked={checked}
                                  disabled={readOnly || (!allowedForRole && !checked)}
                                  onChange={(e) => toggle(p, e.target.checked)}
                                  data-testid={`perm-${p.key}`}
                                />
                                <span className="min-w-0">
                                  <span className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{p.label}</span>
                                    <KindBadge p={p} />
                                  </span>
                                  <span className="block text-xs text-muted">{p.reveals}</span>
                                  {!allowedForRole && <span className="mt-0.5 block text-xs text-warn">Needs the Manager or Custom role.</span>}
                                  {!p.available && catalog.hasStore && <span className="mt-0.5 block text-xs text-muted">Your store hasn&apos;t given bizinsights this data in Shopify yet, so it shows nothing for now.</span>}
                                </span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      {m.id === "staff" && (
                        <div className="mt-2 border-t border-border pt-3">
                          <label htmlFor={`${id}-staff-role`} className="label">Staff Management role (optional)</label>
                          <select
                            id={`${id}-staff-role`}
                            className="input"
                            value={draft.staffRole ?? ""}
                            disabled={readOnly}
                            onChange={(e) => onChange({ ...draft, staffRole: (e.target.value || null) as StaffRole | null })}
                          >
                            <option value="">No staff role</option>
                            {catalog.staffRoles.map((r) => (
                              <option key={r.id} value={r.id} disabled={r.id === "supervisor" && staffTicked}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-muted">{catalog.staffRoles.find((r) => r.id === draft.staffRole)?.description ?? "A staff role adds Staff Management rights on top of the permissions above."}</p>
                          {draft.staffRole === "supervisor" && staffTicked && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-warn">
                              <ShieldAlert aria-hidden className="h-3.5 w-3.5" /> A supervisor sees only their assigned employees: untick the Staff permissions or pick another role.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
