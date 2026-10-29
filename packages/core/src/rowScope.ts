import { onUnscopedSystemQuery } from "@app/db";
import { currentLogContext, logger } from "./logger.js";

/**
 * Log the system queries that run in no row scope (forTenant / crossTenant / withoutTenant, @app/db;
 * docs/system-database-role.md): once per request, job or tick, with its log context (requestId,
 * queue and messageId, cron) and where in the code it came from. Every entry point names a scope,
 * so each line is one that was missed; the rollout's last step, which makes such a query fail,
 * waits for a week without any.
 */
export function reportUnscopedSystemQueries() {
  const reported = new WeakSet<object>();
  let bareAt = 0;
  onUnscopedSystemQuery(() => {
    const entry = currentLogContext();
    if (entry) {
      if (reported.has(entry)) return;
      reported.add(entry);
    } else {
      // Outside any request, job or tick (a module's start-up): once a minute is enough to find it.
      if (Date.now() - bareAt < 60_000) return;
      bareAt = Date.now();
    }
    const stack = (new Error().stack ?? "").split("\n").slice(1, 16).map((l) => l.trim());
    logger.warn({ stack }, "system query in no row scope (forTenant/crossTenant/withoutTenant)");
  });
}
