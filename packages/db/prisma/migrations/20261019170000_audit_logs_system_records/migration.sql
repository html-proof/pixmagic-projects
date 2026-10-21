-- audit_logs.workspace_id may be null: a system record that outlives the workspace it was about.
-- shop/redact erases a store's workspace with it when nobody ever claimed it (App Review's stores,
-- every reviewer's erase), and the gdpr.shop_redacted row written for that workspace failed its
-- foreign key, so no record of the erasure stayed. It is now written with no workspace, in the
-- erase's own transaction. The foreign key stays ON DELETE CASCADE, so a deleted workspace's own
-- log still goes with it; the RLS policy (workspace_id = the request's workspace) shows a null row
-- to no tenant and refuses a tenant's insert of one. Expand only: the code before it never writes null.
-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "workspace_id" DROP NOT NULL;
