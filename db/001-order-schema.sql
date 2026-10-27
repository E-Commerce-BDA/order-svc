-- order-svc schema definition
-- Database: PostgreSQL 16+
-- Schema: order
-- Documentation: 3.Database-Schema.md §3.4

CREATE SCHEMA IF NOT EXISTS "order";

-- ============================================================================
-- Utility Trigger Functions
-- ============================================================================
CREATE OR REPLACE FUNCTION "order".set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 1. discount_codes (Coupons)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".discount_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  discount_type VARCHAR(10) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  value DECIMAL(12,2) NOT NULL CHECK (
    value >= 0 AND (
      (discount_type = 'percent' AND value <= 100) OR
      (discount_type = 'fixed')
    )
  ),
  min_order_amount DECIMAL(12,2) NULL CHECK (min_order_amount IS NULL OR min_order_amount >= 0),
  max_uses INTEGER NULL CHECK (max_uses IS NULL OR max_uses > 0),
  uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  starts_at TIMESTAMPTZ NULL,
  ends_at TIMESTAMPTZ NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discount_codes_valid 
  ON "order".discount_codes (is_active, ends_at) 
  WHERE is_active;

DROP TRIGGER IF EXISTS trg_discount_codes_updated_at ON "order".discount_codes;
CREATE TRIGGER trg_discount_codes_updated_at
  BEFORE UPDATE ON "order".discount_codes
  FOR EACH ROW EXECUTE FUNCTION "order".set_updated_at();

-- ============================================================================
-- 2. orders
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_number VARCHAR(30) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'failed', 'refunded')
  ),
  subtotal DECIMAL(12,2) NOT NULL CHECK (subtotal >= 0),
  shipping_fee DECIMAL(12,2) NOT NULL DEFAULT 0.00 CHECK (shipping_fee >= 0),
  tax DECIMAL(12,2) NOT NULL DEFAULT 0.00 CHECK (tax >= 0),
  discount DECIMAL(12,2) NOT NULL DEFAULT 0.00 CHECK (discount >= 0),
  grand_total DECIMAL(12,2) NOT NULL CHECK (grand_total >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    payment_status IN ('pending', 'paid', 'failed', 'refunded')
  ),
  shipping_address JSONB NOT NULL,
  billing_address JSONB NOT NULL,
  discount_code_id UUID NULL REFERENCES "order".discount_codes(id) ON DELETE SET NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_created 
  ON "order".orders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status 
  ON "order".orders (status);

CREATE INDEX IF NOT EXISTS idx_orders_created_at 
  ON "order".orders (created_at);

CREATE INDEX IF NOT EXISTS idx_orders_payment_status 
  ON "order".orders (payment_status);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON "order".orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON "order".orders
  FOR EACH ROW EXECUTE FUNCTION "order".set_updated_at();

-- ============================================================================
-- 3. order_items
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order".orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID NULL,
  product_name VARCHAR(255) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL CHECK (unit_price >= 0),
  qty INTEGER NOT NULL CHECK (qty > 0),
  line_total DECIMAL(12,2) NOT NULL CHECK (line_total >= 0),
  options JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id 
  ON "order".order_items (order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id 
  ON "order".order_items (product_id);

-- ============================================================================
-- 4. order_status_history
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order".orders(id) ON DELETE CASCADE,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  note VARCHAR(500) NULL,
  actor VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_osh_order_id 
  ON "order".order_status_history (order_id);

-- ============================================================================
-- 5. payments
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order".orders(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL DEFAULT 'mock' CHECK (provider IN ('mock', 'stripe', 'paypal')),
  amount DECIMAL(12,2) NOT NULL CHECK (amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'authorized', 'captured', 'failed', 'refunded')
  ),
  transaction_id VARCHAR(100) NULL UNIQUE,
  paid_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id 
  ON "order".payments (order_id);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON "order".payments;
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON "order".payments
  FOR EACH ROW EXECUTE FUNCTION "order".set_updated_at();

-- ============================================================================
-- 6. outbox (Transactional Outbox Pattern)
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL UNIQUE,
  aggregate_type VARCHAR(50) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending 
  ON "order".outbox (status, created_at) 
  WHERE status = 'pending';

-- ============================================================================
-- 7. shipments [optional]
-- ============================================================================
CREATE TABLE IF NOT EXISTS "order".shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES "order".orders(id) ON DELETE CASCADE,
  carrier VARCHAR(50) NULL,
  tracking_number VARCHAR(100) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'shipped', 'in_transit', 'delivered', 'returned')
  ),
  shipped_at TIMESTAMPTZ NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipments_order_id 
  ON "order".shipments (order_id);

DROP TRIGGER IF EXISTS trg_shipments_updated_at ON "order".shipments;
CREATE TRIGGER trg_shipments_updated_at
  BEFORE UPDATE ON "order".shipments
  FOR EACH ROW EXECUTE FUNCTION "order".set_updated_at();
