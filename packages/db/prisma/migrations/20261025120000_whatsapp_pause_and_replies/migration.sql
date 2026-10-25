-- WhatsApp Automation (docs/whatsapp.md): "Pause all automation" per store, and workflows that
-- answer a customer's message with a reply of the merchant's own (text within WhatsApp's 24-hour
-- window). Additive only: nullable columns, no default rewrites, so the release before keeps working.

-- AlterTable
ALTER TABLE "wa_settings" ADD COLUMN     "automation_paused_at" TIMESTAMP(3),
ADD COLUMN     "automation_paused_by" TEXT;

-- AlterTable
ALTER TABLE "wa_workflows" ADD COLUMN     "reply_cooldown_minutes" INTEGER,
ADD COLUMN     "reply_text" TEXT;
