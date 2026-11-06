-- The self-hosted runtime's tables (docs/ikorex-migration): the job queue and its dead letters, the
-- schedule ticks and the coordinator, which SQS, EventBridge Scheduler and DynamoDB hold on AWS
-- (apps/aws/src/pgQueues.ts, schedules.ts, pgCoord.ts). Expand-only: four new tables, nothing else
-- touched. On AWS they stay empty.
-- CreateTable
CREATE TABLE "job_queue" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "receives" INTEGER NOT NULL DEFAULT 0,
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "claim_token" UUID,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_dead" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "receives" INTEGER NOT NULL,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "died_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_dead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_ticks" (
    "name" TEXT NOT NULL,
    "tick" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "error" TEXT,
    "result" JSONB,

    CONSTRAINT "schedule_ticks_pkey" PRIMARY KEY ("name","tick")
);

-- CreateTable
CREATE TABLE "coord_entries" (
    "k" TEXT NOT NULL,
    "v" TEXT NOT NULL DEFAULT '',
    "n" INTEGER NOT NULL DEFAULT 0,
    "until" BIGINT NOT NULL,

    CONSTRAINT "coord_entries_pkey" PRIMARY KEY ("k")
);

-- CreateIndex
CREATE INDEX "job_queue_queue_run_after_idx" ON "job_queue"("queue", "run_after");

-- CreateIndex
CREATE INDEX "job_dead_queue_died_at_idx" ON "job_dead"("queue", "died_at");

-- CreateIndex
CREATE INDEX "schedule_ticks_started_at_idx" ON "schedule_ticks"("started_at");

-- CreateIndex
CREATE INDEX "coord_entries_until_idx" ON "coord_entries"("until");


-- No tenant data, so no row-level security; the system login (app_system) reads and writes them by
-- the default privileges, and tenant requests get no rights at all (also in infra/postgres/init.sql,
-- which re-runs after its blanket grant).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE ALL ON "job_queue", "job_dead", "schedule_ticks", "coord_entries" FROM app_rls;
  END IF;
END $$;
