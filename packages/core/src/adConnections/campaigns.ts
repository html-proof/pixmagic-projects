/**
 * Each campaign as its platform last described it to a sync (ad_campaigns): its name, status, and,
 * where the platform gives them, its channel type, primary status and budget (AdCampaignFacts). The
 * syncs write it (storeCampaigns in sync.ts); the dashboard's campaign comparison and the Google Ads
 * analytics page read it.
 */
import { toNumber, type Prisma, type Tx } from "@app/db";
import type { AdCampaignFacts } from "@app/shared";

/**
 * Whether ad_campaigns has the facts' columns (migration 20261030180000_ad_campaign_settings). A deploy
 * runs the new code a minute or two before its migrations (docs/database/migrations.md): until then a
 * query naming them would fail, and with it the dashboard's whole answer (one transaction), so readers
 * and the sync leave the facts out. Asked once per process after they exist.
 */
let ready = false;
export async function campaignFactsReady(db: Pick<Tx, "$queryRaw">): Promise<boolean> {
  if (ready) return true;
  const [row] = await db.$queryRaw<Array<{ ok: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('ad_campaigns') AND attname = 'budget_amount' AND NOT attisdropped) AS ok`;
  ready = row?.ok === true;
  return ready;
}

/** A campaign as stored, its facts null (and no reasons) while they're unread or the columns don't exist yet. */
export interface StoredCampaign extends AdCampaignFacts {
  provider: string;
  accountId: string;
  campaignId: string;
  name: string;
  status: string | null;
  /** When a sync last read its status (and its facts, when its platform gives them). */
  checkedAt: Date;
}

const NO_FACTS: AdCampaignFacts = { channelType: null, primaryStatus: null, primaryStatusReasons: [], budgetPeriod: null, budgetAmount: null };

/** The stored campaigns `where` picks (scoped by the caller: workspace, store, connections). */
export async function storedCampaigns(tx: Tx, where: Prisma.AdCampaignWhereInput): Promise<StoredCampaign[]> {
  const base = { provider: true, accountId: true, campaignId: true, name: true, status: true, checkedAt: true } as const;
  if (!(await campaignFactsReady(tx))) return (await tx.adCampaign.findMany({ where, select: base })).map((c) => ({ ...c, ...NO_FACTS }));
  const rows = await tx.adCampaign.findMany({
    where,
    select: { ...base, channelType: true, primaryStatus: true, primaryStatusReasons: true, budgetPeriod: true, budgetAmount: true },
  });
  return rows.map((c) => ({ ...c, budgetAmount: c.budgetAmount === null ? null : toNumber(c.budgetAmount) }));
}

/** Stored campaigns by provider:accountId:campaignId, the key the campaign totals carry. */
export const campaignKeyOf = (c: Pick<StoredCampaign, "provider" | "accountId" | "campaignId">) => `${c.provider}:${c.accountId}:${c.campaignId}`;
