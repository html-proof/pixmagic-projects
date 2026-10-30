"use client";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryParam } from "@/components/advertising/useAdvertising";

// ---------------------------------------------------------------------------
// Down from a campaign in the live Meta and Google Ads reports: the campaign opened (?campaign=) and,
// under it, the ad set (?adset=, Meta) or ad group (?adgroup=, Google), kept in the address bar
// beside the dates and the account so a link reproduces the view. Only ids are kept there; names
// are what the row clicked said, else what the answer's rows say (the panels).
// ---------------------------------------------------------------------------

export interface ReportDrill {
  /** The address has been read: until then the panel asks nothing, so a link doesn't first ask for the whole account. */
  ready: boolean;
  campaign: string | null;
  /** The ad set (Meta) or ad group (Google) opened, under the campaign when one is. */
  child: string | null;
  /** A drill-down is open. */
  open: boolean;
  /** The name a row clicked (or a list read, `learn`) gave this id, if one did. */
  nameOf: (id: string | null) => string | null;
  /** Names from a list the panel read (a campaign opened by a link, looked up on the campaign list). */
  learn: (names: Record<string, string>) => void;
  /** Open a campaign's rows, or (with `child`) an ad set's or ad group's. */
  go: (campaign: { id: string; name: string } | null, child?: { id: string; name: string }) => void;
  /** Back to the campaign (from its ad set or ad group). */
  up: () => void;
  /** Back to the whole account. */
  top: () => void;
  /** How many steps (go, up, top) the person has taken: useDrillFocus moves focus to where each one lands. */
  moved: number;
}

/**
 * The drill-down of one panel, for the connection `connectionId`: a campaign's ids belong to one ad
 * account, so picking another account starts from all its campaigns (the store's change clears the
 * address in useAdvertising, REPORT_DRILL_PARAMS). The drill is the account's it was opened on: from
 * the render the account changes in, it reads as closed, so the panel's first question of the other
 * account is already about all of it, never the old campaign's rows asked of an account that hasn't it.
 */
export function useReportDrill(childParam: "adset" | "adgroup", valid: (v: string) => v is string, connectionId: string | undefined): ReportDrill {
  const [campaign, setCampaign] = useQueryParam("campaign", valid);
  const [child, setChild] = useQueryParam(childParam, valid);
  const [names, setNames] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const [moved, setMoved] = useState(0);
  // After the address-bar reads above (effects run in order, and their updates land together).
  useEffect(() => setReady(true), []);
  const clear = useCallback(() => {
    setCampaign(null);
    setChild(null);
  }, [setCampaign, setChild]);
  // The account the drill belongs to; another one picked closes it (in the same flush as its address).
  const [openedOn, setOpenedOn] = useState(connectionId);
  const otherAccount = openedOn !== undefined && connectionId !== openedOn;
  useEffect(() => {
    if (connectionId === openedOn) return;
    if (openedOn !== undefined) clear();
    setOpenedOn(connectionId);
  }, [connectionId, openedOn, clear]);
  const shownCampaign = otherAccount ? null : campaign;
  const shownChild = otherAccount ? null : child;
  return {
    ready,
    campaign: shownCampaign,
    child: shownChild,
    open: shownCampaign !== null || shownChild !== null,
    nameOf: (id) => (id === null ? null : (names[id] ?? null)),
    learn: (more) => setNames((n) => ({ ...more, ...n })),
    go: (c, ch) => {
      setCampaign(c?.id ?? null);
      setChild(ch?.id ?? null);
      setNames((n) => ({ ...n, ...(c ? { [c.id]: c.name } : {}), ...(ch ? { [ch.id]: ch.name } : {}) }));
      setMoved((m) => m + 1);
    },
    up: () => {
      setChild(null);
      setMoved((m) => m + 1);
    },
    top: () => {
      clear();
      setMoved((m) => m + 1);
    },
    moved,
  };
}

/** Where a step lands: the crumb now current, or (back at the whole account) the level picked. */
const LANDING = '[aria-current="page"], [role="tab"][aria-selected="true"]';

/**
 * A step down or up swaps the panel's table, the row or crumb pressed included, for a placeholder while
 * the next level loads, so focus would drop to the page. After each step (`drill.moved`) it goes to where
 * the step landed in the panel (`panelId`) instead, once that is on screen (a panel whose level tabs come
 * with its answer: then), unless the person has put focus somewhere else meanwhile.
 */
export function useDrillFocus(drill: Pick<ReportDrill, "moved">, panelId: string): void {
  const pending = useRef(false);
  useEffect(() => {
    if (drill.moved) pending.current = true;
  }, [drill.moved]);
  // After every render: the landing may come only with the answer.
  useEffect(() => {
    if (!pending.current) return;
    const panel = document.getElementById(panelId);
    const active = document.activeElement;
    if (!panel || (active && active !== document.body && !panel.contains(active))) {
      pending.current = false;
      return;
    }
    const landing = panel.querySelector<HTMLElement>(LANDING);
    if (!landing) return;
    pending.current = false;
    landing.focus();
  });
}

/** "All campaigns › Spring sale › Women 25-34": each step but the last goes back up. */
export function DrillCrumbs({ steps, testid }: { steps: Array<{ label: string; onClick?: () => void }>; testid: string }) {
  return (
    <nav aria-label="Where in the report" className="mb-3 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm" data-testid={testid}>
      {steps.map((s, i) => (
        <span key={i} className="inline-flex min-w-0 items-center gap-x-1.5">
          {i > 0 && <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />}
          {s.onClick && i < steps.length - 1 ? (
            <button type="button" className="truncate text-accent underline-offset-2 hover:underline" onClick={s.onClick}>
              {s.label}
            </button>
          ) : (
            <span aria-current="page" tabIndex={-1} className="truncate font-medium" title={s.label}>
              {s.label}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

/** A row's name that opens what is under it (a campaign's ad sets or ad groups, an ad set's or ad group's ads). */
export function OpenRow({ name, what, onClick, testid }: { name: string; what: string; onClick: () => void; testid: string }) {
  return (
    <button type="button" className="inline-flex max-w-full items-center gap-1 text-left font-medium text-accent underline-offset-2 hover:underline" title={`${name}: view its ${what}`} onClick={onClick} data-testid={testid}>
      <span className="truncate">{name}</span>
      <span className="sr-only">: view its {what}</span>
      <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}
