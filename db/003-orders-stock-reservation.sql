-- 003-orders-stock-reservation.sql
--
-- Links an order to the catalog hold that was taken for it.
--
-- No FK: catalog.stock_reservations lives in another schema, and cross-schema
-- foreign keys are forbidden (each service owns its own schema only).
-- Nullable: rows written before this migration have no hold, and a hold is
-- optional for orders that were created outside checkout.

ALTER TABLE "order".orders
  ADD COLUMN IF NOT EXISTS stock_reservation_id uuid NULL;

CREATE INDEX IF NOT EXISTS idx_orders_stock_reservation
  ON "order".orders (stock_reservation_id)
  WHERE stock_reservation_id IS NOT NULL;
