-- A workspace made for a store installed from Shopify, waiting for its merchant to claim it.
-- Only these can be claimed: a workspace that merely has no members (an edge case) never can.
ALTER TABLE "workspaces" ADD COLUMN "awaiting_claim" BOOLEAN NOT NULL DEFAULT false;
