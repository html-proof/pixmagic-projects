-- Drops the two columns left over from Firebase Authentication. Nothing has read or written
-- them since PR #163 (which @ignore'd them in schema.prisma), and that release is the one a
-- deploy of this migration would roll back to, so no running code can miss them.

-- DropIndex
DROP INDEX "users_firebase_uid_key";

-- AlterTable
ALTER TABLE "auth_identities" DROP COLUMN "migrated_from_firebase_uid";

-- AlterTable
ALTER TABLE "users" DROP COLUMN "firebase_uid";
