-- From when every stored order of a store carries its customer: the moment the store granted
-- read_customers, moved back to the start of the orders import that re-read its orders since
-- (docs/customer-analytics.md "Where it starts"). Expand-only: one new nullable column. Stores that
-- granted read_customers before it existed keep null, and the customer report goes on inferring
-- their day from the orders, as the code live before this release does for every store.
ALTER TABLE "stores" ADD COLUMN "customers_from" TIMESTAMP(3);
