/**
 * Typed row representations mirroring the PostgreSQL `order` schema.
 *
 * Money is `number` here: `DECIMAL(12,2)` is parsed to a JS number by the NUMERIC
 * type parser in `db/pool.ts`, so a row is the same shape as every other response
 * in the service. Columns stay `DECIMAL` — exact decimal storage is the money
 * convention; only the driver's default string output is overridden.
 * Reference: Documentation/3.Database-Schema.md §3.4
 */

export interface DiscountCodeRow {
  id: string;
  code: string;
  discount_type: 'percent' | 'fixed';
  value: number;
  min_order_amount: number | null;
  max_uses: number | null;
  uses_count: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'failed'
  | 'refunded';

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface OrderAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
}

export interface OrderRow {
  id: string;
  user_id: string;
  order_number: string;
  status: OrderStatus;
  subtotal: number;
  shipping_fee: number;
  tax: number;
  discount: number;
  grand_total: number;
  currency: string;
  payment_status: PaymentStatus;
  shipping_address: OrderAddress;
  billing_address: OrderAddress;
  discount_code_id: string | null;
  stock_reservation_id: string | null;
  idempotency_key: string | null;
  idempotency_body_hash: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string | null;
  product_name: string;
  sku: string;
  unit_price: number;
  qty: number;
  line_total: number;
  options: Record<string, string> | null;
}

export interface OrderStatusHistoryRow {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  note: string | null;
  actor: string;
  created_at: string;
}

export type PaymentProvider = 'mock' | 'stripe' | 'paypal';
export type PaymentLifecycleStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'refunded';

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: PaymentProvider;
  amount: number;
  status: PaymentLifecycleStatus;
  transaction_id: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One refund per order in v1; the row is also the retry slot. */
export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string;
  amount: number;
  status: RefundStatus;
  provider_reference: string | null;
  failure_reason: string | null;
  reason: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
}

export type OutboxStatus = 'pending' | 'published' | 'failed';

export interface OutboxRow {
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  envelope: Record<string, unknown> | null;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  locked_until: string | null;
  created_at: string;
  published_at: string | null;
}

export type ShipmentStatus =
  | 'pending'
  | 'shipped'
  | 'in_transit'
  | 'delivered'
  | 'returned';

export interface ShipmentRow {
  id: string;
  order_id: string;
  carrier: string | null;
  tracking_number: string | null;
  status: ShipmentStatus;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}
