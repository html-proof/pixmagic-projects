-- Settings → Security: the devices an account is signed in on (one row per session).

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "device" JSONB,
    "ip" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_sid_key" ON "user_sessions"("sid");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_last_seen_at_idx" ON "user_sessions"("user_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Sign-in data: the tenant role (app_rls) must never touch it.
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE ALL ON "user_sessions" FROM app_rls;
  END IF;
END $$;
