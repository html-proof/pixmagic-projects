-- The number's two-step verification PIN (encrypted), set by Insights when it registers an Embedded Signup number.
ALTER TABLE "whatsapp_connections" ADD COLUMN "pin_enc" TEXT;
