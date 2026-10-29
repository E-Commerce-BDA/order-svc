-- 004-orders-idempotency.sql
--
-- Makes the order row the authority for "one idempotency key = one order".
--
-- Before this, the only record of a checkout attempt was the Redis response
-- cache (`idem:{key}`): a crash between COMMIT and the cache write produced a
-- duplicate order on retry, and the global key let one user replay another
-- user's confirmation. The key now lives on the row it protects.
--
-- Nullable: seeded and historical rows predate the column, and an order created
-- outside checkout carries no key.
--
-- The partial unique index is the concurrency gate, not just a lookup:
--   * scoped by user_id, so two customers generating the same UUID are isolated;
--   * partial, so the many NULL keys do not collide;
--   * the loser of a race gets 23505 (constraint idx_orders_idem) instead of a
--     second order, which is exactly the dedupe the caller needs.

ALTER TABLE "order".orders
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128) NULL,
  ADD COLUMN IF NOT EXISTS idempotency_body_hash char(64) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idem
  ON "order".orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
