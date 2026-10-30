-- Zapier (docs/zapier.md): what a connection may do beyond its triggers and searches, as the member
-- ticked it on the consent page. "whatsapp_send": the "Send WhatsApp Template Message" action.
-- Additive only: connections made before have none, so they keep sending nothing.

-- AlterTable
ALTER TABLE "zapier_grants" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
