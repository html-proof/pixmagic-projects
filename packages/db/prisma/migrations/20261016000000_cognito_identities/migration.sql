-- Sign-in moves from Firebase Authentication to Amazon Cognito (docs/cognito-setup.md).
--
-- users.id stays the key everything else points at. A Cognito user (password, Google or Apple)
-- is linked to it through auth_identities, several per user when someone signs in more than one
-- way. users.firebase_uid stays as it is for existing accounts (it is how a first Cognito sign-in
-- finds its Firebase account, and how a rollback finds every account again) and is empty for
-- accounts created on Cognito. Additive: nothing existing is rewritten, so the previous Worker
-- version keeps working on this schema.

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "firebase_uid" DROP NOT NULL,
ADD COLUMN     "sessions_valid_after" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "email" TEXT,
    "migrated_from_firebase_uid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "ip" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_subject_key" ON "auth_identities"("provider", "subject");

-- CreateIndex
CREATE INDEX "auth_events_user_id_created_at_idx" ON "auth_events"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sign-in data: the tenant role (app_rls) must never touch it.
ALTER TABLE "auth_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "auth_events" ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
    REVOKE ALL ON "auth_identities" FROM app_rls;
    REVOKE ALL ON "auth_events" FROM app_rls;
  END IF;
END $$;
