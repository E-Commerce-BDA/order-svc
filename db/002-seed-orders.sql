-- Seed fixtures for order-svc testing and development
-- Schema: order

-- ============================================================================
-- Discount Codes Seed Fixtures
-- ============================================================================
INSERT INTO "order".discount_codes (
  id, code, discount_type, value, min_order_amount, max_uses, uses_count, starts_at, ends_at, is_active
) VALUES
  (
    '018f0000-0000-7000-8000-000000000001',
    'SAVE10',
    'percent',
    10.00,
    NULL,
    100,
    0,
    now() - interval '1 day',
    now() + interval '365 days',
    true
  ),
  (
    '018f0000-0000-7000-8000-000000000002',
    'FLAT20',
    'fixed',
    20.00,
    50.00,
    NULL,
    0,
    now() - interval '1 day',
    now() + interval '365 days',
    true
  ),
  (
    '018f0000-0000-7000-8000-000000000003',
    'EXPIRED50',
    'percent',
    50.00,
    NULL,
    NULL,
    0,
    '2024-01-01 00:00:00+00',
    '2024-02-01 00:00:00+00',
    true
  ),
  (
    '018f0000-0000-7000-8000-000000000004',
    'MAXEDOUT',
    'fixed',
    15.00,
    NULL,
    5,
    5,
    now() - interval '5 days',
    now() + interval '30 days',
    true
  ),
  (
    '018f0000-0000-7000-8000-000000000005',
    'DISABLED5',
    'percent',
    5.00,
    NULL,
    NULL,
    0,
    now() - interval '1 day',
    now() + interval '30 days',
    false
  )
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- Sample Seed Order
-- ============================================================================
INSERT INTO "order".orders (
  id,
  user_id,
  order_number,
  status,
  subtotal,
  shipping_fee,
  tax,
  discount,
  grand_total,
  currency,
  payment_status,
  shipping_address,
  billing_address,
  discount_code_id,
  notes,
  created_at
) VALUES (
  '018f0000-0000-7000-8000-000000000010',
  '018f0000-0000-7000-8000-000000000099',
  '#2026-000001',
  'confirmed',
  159.98,
  5.00,
  0.00,
  16.00,
  148.98,
  'USD',
  'paid',
  '{"line1": "123 Main St", "city": "Seattle", "state": "WA", "postalCode": "98101", "country": "US"}',
  '{"line1": "123 Main St", "city": "Seattle", "state": "WA", "postalCode": "98101", "country": "US"}',
  '018f0000-0000-7000-8000-000000000001',
  'First sample order for e2e testing',
  now() - interval '1 hour'
)
ON CONFLICT (order_number) DO NOTHING;

-- Order Items
INSERT INTO "order".order_items (
  id,
  order_id,
  product_id,
  variant_id,
  product_name,
  sku,
  unit_price,
  qty,
  line_total,
  options
) VALUES
  (
    '018f0000-0000-7000-8000-000000000021',
    '018f0000-0000-7000-8000-000000000010',
    '018f0000-0000-7000-8000-000000000101',
    '018f0000-0000-7000-8000-000000000102',
    'Running Shoe X',
    'RSX-S-RED',
    79.99,
    2,
    159.98,
    '{"Size": "S", "Color": "Red"}'
  )
ON CONFLICT DO NOTHING;

-- Order Status History
INSERT INTO "order".order_status_history (
  id,
  order_id,
  from_status,
  to_status,
  note,
  actor,
  created_at
) VALUES
  (
    '018f0000-0000-7000-8000-000000000031',
    '018f0000-0000-7000-8000-000000000010',
    NULL,
    'confirmed',
    'Order placed and payment authorized',
    '018f0000-0000-7000-8000-000000000099',
    now() - interval '1 hour'
  )
ON CONFLICT DO NOTHING;

-- Payment Record
INSERT INTO "order".payments (
  id,
  order_id,
  provider,
  amount,
  status,
  transaction_id,
  paid_at,
  created_at
) VALUES
  (
    '018f0000-0000-7000-8000-000000000041',
    '018f0000-0000-7000-8000-000000000010',
    'mock',
    148.98,
    'captured',
    'mock_tx_000001',
    now() - interval '1 hour',
    now() - interval '1 hour'
  )
ON CONFLICT (transaction_id) DO NOTHING;
