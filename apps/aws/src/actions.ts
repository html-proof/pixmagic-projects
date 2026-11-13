import { readFileSync } from "node:fs";
import { join } from "node:path";
import { seedAfterMove, seedSalesRereads, settleAllCustomers, startChecks, type WorkerDeps } from "@app/worker";
import { configReport, defaultShard, evolutionStatus, logger } from "@app/core";
import { productCheck, shopifyCheckReport } from "@app/core/reports";
import { crossTenant, systemDb } from "@app/db";
import { ensureEvolutionDb } from "./evolutionDb.js";
import { migrate, tableCounts } from "./migrate.js";

/**
 * The maintenance actions, once shared with the AWS cron function ({ "action": ... } invocations
 * from the deploy scripts) and the self-hosted admin command (admin.ts: `admin <action>`). Each
 * deployment supplies its own way to get the jobs' dependencies and to have its settings ready.
 */
export const ACTIONS = ["migrate", "counts", "after-move", "reread", "verify", "shopify-check", "product-check", "config", "evolution-db"] as const;
export type ActionName = (typeof ACTIONS)[number];

export interface Action {
  action: ActionName;
  /** verify: one store (its myshopify domain) instead of every connected one; shopify-check, product-check: the store. */
  shop?: string;
  /** verify: how many finished days back (7 by default). */
  days?: number;
  /** verify: record what differs, repair nothing. */
  dryRun?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

export interface ActionContext {
  /** The jobs' dependencies (after the settings are ready). */
  jobs(): Promise<WorkerDeps>;
  /** Settings and secrets into process.env. */
  ready(): Promise<void>;
  /** The folder holding migrations/ and init.sql (next to the bundle). */
  dir: string;
}

export const isAction = (name: unknown): name is ActionName => typeof name === "string" && (ACTIONS as readonly string[]).includes(name);

export async function runAction(e: Action, ctx: ActionContext): Promise<unknown> {
  switch (e.action) {
    case "after-move": {
      // Once, after the database is copied in from another deployment (docs/aws-deployment.md, Cutover).
      const result = await crossTenant("maintenance", async () => seedAfterMove(await ctx.jobs()));
      logger.info(result, "after-move repair queued");
      return result;
    }
    case "reread": {
      // After each deploy's migrations: stores whose orders lack their sales records or their
      // customer's history (seedSalesRereads), and new vs returning customers settled again.
      const deps = await ctx.jobs();
      return crossTenant("maintenance", async () => {
        const settledDays = await settleAllCustomers(deps);
        const queued = await seedSalesRereads(deps);
        return { queued, settledDays };
      });
    }
    case "verify": {
      // Check stores' figures against Shopify now (docs/RUNBOOK.md); the daily check runs by itself.
      const deps = await ctx.jobs();
      return crossTenant("maintenance", () =>
        startChecks(deps, {
          shop: typeof e.shop === "string" ? e.shop : undefined,
          days: typeof e.days === "number" && e.days >= 1 && e.days <= 366 ? Math.floor(e.days) : undefined,
          dryRun: e.dryRun === true,
        }),
      );
    }
    case "shopify-check": {
      // The reconciliation report for one store (core reports/shopifyCheck.ts): every figure of the
      // standard periods, ours next to Shopify's own reports, read live. Read-only; docs/RUNBOOK.md.
      const deps = await ctx.jobs();
      return crossTenant("maintenance", async () => {
        const store = e.shop ? await systemDb.store.findUnique({ where: { shopDomain: e.shop } }) : null;
        if (!store) return { error: "unknown_shop" };
        return shopifyCheckReport((read) => read(systemDb), store, deps);
      });
    }
    case "product-check": {
      const deps = await ctx.jobs();
      return crossTenant("maintenance", async () => {
        const stores = await systemDb.store.findMany({ where: { status: "active", ...(e.shop ? { shopDomain: e.shop } : {}) } });
        const results = [];
        for (const store of stores) {
          try {
            results.push(await productCheck(systemDb, store, deps, e.dateFrom && e.dateTo ? { from: e.dateFrom, to: e.dateTo } : undefined));
          } catch (err) {
            results.push({ shop: store.shopDomain, status: "not_verifiable", reason: err instanceof Error ? err.message : "Report failed" });
          }
        }
        return { results };
      });
    }
    case "config": {
      // What this deployment has set up (core configReport.ts): booleans and setting names, never a
      // value. The deploy's smoke test warns about each provider whose secret is missing.
      await ctx.ready();
      const report = configReport();
      // The WhatsApp service is private: only from in here can the deploy see that the app reaches it.
      if (report.whatsapp.evolution) report.whatsapp.service = await evolutionStatus(defaultShard(), fetch);
      return report;
    }
    case "evolution-db": {
      // The WhatsApp service's own database and role (evolutionDb.ts): before the service starts.
      // Idempotent; the password comes from the environment.
      await ctx.ready();
      const env = process.env;
      if (!env.OWNER_DATABASE_URL || !env.EVOLUTION_DB_PASSWORD) throw new Error("OWNER_DATABASE_URL and EVOLUTION_DB_PASSWORD must be set");
      const result = await ensureEvolutionDb({ databaseUrl: env.OWNER_DATABASE_URL, user: env.EVOLUTION_DB_USER || "evolution", password: env.EVOLUTION_DB_PASSWORD, database: "evolution" });
      logger.info(result, "evolution database ready");
      return result;
    }
    case "migrate":
    case "counts": {
      await ctx.ready();
      // The owner's login: migrations change tables, which the system role can't.
      const ownerUrl = process.env.OWNER_DATABASE_URL;
      if (!ownerUrl) throw new Error("OWNER_DATABASE_URL is not set (the server's env/owner.env)");
      if (e.action === "counts") return tableCounts(ownerUrl);
      // Without it init.sql would make the system role with its development password.
      if (process.env.NODE_ENV === "production" && !process.env.SYSTEM_DB_PASSWORD) throw new Error("SYSTEM_DB_PASSWORD is not set (the server's env/owner.env)");
      const result = await migrate({
        databaseUrl: ownerUrl,
        migrationsDir: join(ctx.dir, "migrations"),
        initSql: readFileSync(join(ctx.dir, "init.sql"), "utf8"),
        appRlsPassword: process.env.APP_RLS_PASSWORD,
        systemPassword: process.env.SYSTEM_DB_PASSWORD,
      });
      logger.info(result, "migrations applied");
      return result;
    }
  }
}
