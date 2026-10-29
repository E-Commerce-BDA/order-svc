-- 005-order-refunds.sql
--
-- A refund is money moving, so it gets a ledger row of its own.
--
-- The endpoint used to flip `orders` and `payments` to `refunded` and publish a
-- non-canonical `order.refunded` event without ever calling the provider: the
-- books said refunded, the customer's money stayed with us, and nothing
-- recorded where it went. The ledger fixes three things at once:
--
--   * contract with the provider — `provider_reference` is the refund id the
--     provider gave us, `failure_reason` is why it did not happen;
--   * idempotency — `UNIQUE (order_id)` is the gate, so a replay finds the
--     existing row instead of refunding twice (v1 allows one refund per order,
--     partial refunds reuse the same row until a follow-up task);
--   * retries — a `failed` row is retried in place, so the amount and the
--     requester survive a provider outage.

CREATE TABLE IF NOT EXISTS "order".refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES "order".orders(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES "order".payments(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','succeeded','failed')),
  provider_reference varchar(100) NULL,
  failure_reason varchar(500) NULL,
  reason varchar(500) NULL,
  requested_by varchar(50) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_order ON "order".refunds (order_id);

DROP TRIGGER IF EXISTS trg_refunds_updated_at ON "order".refunds;
CREATE TRIGGER trg_refunds_updated_at
  BEFORE UPDATE ON "order".refunds
  FOR EACH ROW EXECUTE FUNCTION "order".set_updated_at();
