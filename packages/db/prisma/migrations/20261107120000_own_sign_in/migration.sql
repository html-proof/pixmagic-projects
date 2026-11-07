-- The app's own sign-in directory (apps/api/src/localAuth.ts), which takes over from Cognito's user
-- pool so the AWS account can close (docs/ikorex-migration). Expand-only: two new tables, nothing
-- else touched. They stay empty until AUTH_MODE is "migrating" or "local".

-- CreateTable
CREATE TABLE "auth_accounts" (
    "sub" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "login_email" TEXT,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "pending_email" TEXT,
    "name" TEXT,
    "picture" TEXT,
    "method" TEXT NOT NULL,
    "password_hash" TEXT,
    "google_sub" TEXT,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "totp_secret" TEXT,
    "totp_pending" TEXT,
    "totp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tokens_valid_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moved_from" TEXT,
    "moved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("sub")
);

-- CreateTable
CREATE TABLE "auth_refresh_tokens" (
    "token_hash" TEXT NOT NULL,
    "sub" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "auth_refresh_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_username_key" ON "auth_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_login_email_key" ON "auth_accounts"("login_email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_google_sub_key" ON "auth_accounts"("google_sub");

-- CreateIndex
CREATE INDEX "auth_refresh_tokens_sub_idx" ON "auth_refresh_tokens"("sub");

-- CreateIndex
CREATE INDEX "auth_refresh_tokens_expires_at_idx" ON "auth_refresh_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_sub_fkey" FOREIGN KEY ("sub") REFERENCES "auth_accounts"("sub") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sign-in secrets: the tenant role (app_rls) must never touch them (as auth_identities).
ALTER TABLE "auth_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_refresh_tokens" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE ALL ON "auth_accounts" FROM app_rls;
    REVOKE ALL ON "auth_refresh_tokens" FROM app_rls;
  END IF;
END $$;
