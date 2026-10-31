import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { DiscountsRepository } from '../discounts/discounts.repository.js';
import {
  OrderOutbox,
  type OrderCreatedWrite,
} from '../outbox/order-outbox.js';
import type {
  OrderItemRow,
  OrderRow,
  OrderStatus,
  PaymentLifecycleStatus,
  PaymentRow,
  PaymentStatus,
} from '../db/rows.js';

/** Human-facing order numbers are six digits under a year prefix. */
const ORDER_NUMBER_PREFIX = '#2026-';
/** A collision is 1-in-900k; three draws make a repeat practically impossible. */
const MAX_ORDER_NUMBER_ATTEMPTS = 3;
const UNIQUE_VIOLATION = '23505';
const ORDER_NUMBER_CONSTRAINT = 'orders_order_number_key';
const IDEMPOTENCY_CONSTRAINT = 'idx_orders_idem';

export interface CheckoutLine {
  productId: string;
  variantId?: string | null;
  productName: string;
  sku: string;
  unitPrice: number;
  qty: number;
  lineTotal: number;
}

export interface CheckoutPaymentWrite {
  provider: 'mock' | 'stripe' | 'paypal';
  amount: number;
  status: PaymentLifecycleStatus;
  transactionId: string | null;
}

export interface CreateOrderInput {
  userId: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  grandTotal: number;
  currency: string;
  shippingAddress: unknown;
  billingAddress: unknown;
  discountCodeId: string | null;
  stockReservationId: string | null;
  idempotencyKey: string;
  idempotencyBodyHash: string;
  notes: string | null;
  items: CheckoutLine[];
  historyNote: string;
  actor: string;
  payment: CheckoutPaymentWrite;
  /** `null` leaves the outbox alone — a pending order has not happened yet. */
  outbox: OutboxWrite | null;
}

export interface PersistedOrder {
  orderId: string;
  orderNumber: string;
}

/**
 * The `order.created` event a confirmation carries. The topic is part of the
 * write so the repository never guesses which event a confirmation produces,
 * and the payload builder is resolved only after the insert generated the
 * order number.
 */
export type OutboxWrite = OrderCreatedWrite;

/**
 * Thrown when `idx_orders_idem` rejects the insert: another attempt with the
 * same (user, key) committed first. The caller owes a refund and a stock release
 * for its own capture and must serve the winner's order.
 */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} is already bound to another order`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

/**
 * Every checkout statement lives here so the saga can be failure-injected
 * without stubbing `pg`. Each write method owns exactly one transaction and
 * always releases its client.
 */
@Injectable()
export class CheckoutRepository {
  constructor(
    private readonly discountsRepository: DiscountsRepository,
    private readonly outbox: OrderOutbox,
  ) {}

  /**
   * The idempotency authority. Scoped by user, so a key can never resolve to
   * another customer's order, and read from the row rather than the cache.
   */
  async findByIdempotencyKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<{ order: OrderRow; items: OrderItemRow[] } | null> {
    const { rows } = await getPool().query<OrderRow>(
      `SELECT * FROM "order".orders
       WHERE user_id = $1 AND idempotency_key = $2
       LIMIT 1;`,
      [userId, idempotencyKey],
    );
    const order = rows[0];
    if (!order) return null;

    const items = await getPool().query<OrderItemRow>(
      `SELECT * FROM "order".order_items WHERE order_id = $1 ORDER BY id;`,
      [order.id],
    );
    return { order, items: items.rows };
  }

  /**
   * One transaction: order, items, status history, payment row, coupon usage
   * and (when supplied) the outbox event.
   *
   * Two unique constraints can reject the insert and each means something
   * different — the order number is retried, the idempotency key is not:
   *   * `orders_order_number_key` — ask for another number and replay the whole
   *     transaction (Postgres already aborted it, so there is nothing to salvage);
   *   * `idx_orders_idem` — someone else owns the key; surface it.
   */
  async createOrder(input: CreateOrderInput): Promise<PersistedOrder> {
    for (let attempt = 1; ; attempt += 1) {
      const orderNumber = this.nextOrderNumber();
      try {
        const orderId = await this.insertOrder(input, orderNumber);
        return { orderId, orderNumber };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;

        if (constraintOf(error) === IDEMPOTENCY_CONSTRAINT) {
          throw new DuplicateIdempotencyKeyError(input.idempotencyKey);
        }

        const isOrderNumber = constraintOf(error) === ORDER_NUMBER_CONSTRAINT;
        if (!isOrderNumber || attempt >= MAX_ORDER_NUMBER_ATTEMPTS) throw error;
      }
    }
  }

  private async insertOrder(
    input: CreateOrderInput,
    orderNumber: string,
  ): Promise<string> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO "order".orders (
          user_id, order_number, status, subtotal, shipping_fee, tax, discount, grand_total,
          currency, payment_status, shipping_address, billing_address, discount_code_id,
          stock_reservation_id, idempotency_key, idempotency_body_hash, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id;`,
        [
          input.userId,
          orderNumber,
          input.status,
          input.subtotal,
          input.shipping,
          input.tax,
          input.discount,
          input.grandTotal,
          input.currency,
          input.paymentStatus,
          JSON.stringify(input.shippingAddress),
          JSON.stringify(input.billingAddress),
          input.discountCodeId,
          input.stockReservationId,
          input.idempotencyKey,
          input.idempotencyBodyHash,
          input.notes,
        ],
      );
      const orderId = rows[0].id;

      for (const item of input.items) {
        await client.query(
          `INSERT INTO "order".order_items (
            order_id, product_id, variant_id, product_name, sku, unit_price, qty, line_total, options
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
          [
            orderId,
            item.productId,
            item.variantId ?? null,
            item.productName,
            item.sku,
            item.unitPrice,
            item.qty,
            item.lineTotal,
            null,
          ],
        );
      }

      await client.query(
        `INSERT INTO "order".order_status_history (
          order_id, from_status, to_status, note, actor
        ) VALUES ($1, $2, $3, $4, $5);`,
        [orderId, null, input.status, input.historyNote, input.actor],
      );

      await client.query(
        `INSERT INTO "order".payments (
          order_id, provider, amount, status, transaction_id, paid_at
        ) VALUES ($1, $2, $3, $4, $5, $6);`,
        [
          orderId,
          input.payment.provider,
          input.payment.amount,
          input.payment.status,
          input.payment.transactionId,
          input.payment.status === 'captured' ? new Date() : null,
        ],
      );

      if (input.discountCodeId) {
        await this.discountsRepository.incrementUsesCount(
          client,
          input.discountCodeId,
        );
      }

      if (input.outbox) {
        await this.outbox.recordOrderCreated(client, input.outbox, {
          orderId,
          orderNumber,
        });
      }

      await client.query('COMMIT');
      return orderId;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private nextOrderNumber(): string {
    return `${ORDER_NUMBER_PREFIX}${randomInt(100_000, 999_999)}`;
  }

  /** The unpaid row a resumed attempt should try to capture again. */
  async findPendingPayment(orderId: string): Promise<PaymentRow | null> {
    const { rows } = await getPool().query<PaymentRow>(
      `SELECT * FROM "order".payments
       WHERE order_id = $1 AND status = 'pending'
       ORDER BY created_at
       LIMIT 1;`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /**
   * TX2: the money is in, so the order may become real. One transaction, and the
   * `status = 'pending'` guards make a replayed confirmation a no-op instead of
   * a double capture record.
   */
  async confirmOrder(
    orderId: string,
    capture: { transactionId: string },
    outbox: OutboxWrite | null,
  ): Promise<PersistedOrder> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const payment = await client.query(
        `UPDATE "order".payments
         SET status = 'captured', transaction_id = $2, paid_at = now(), updated_at = now()
         WHERE order_id = $1 AND status = 'pending';`,
        [orderId, capture.transactionId],
      );
      if ((payment.rowCount ?? 0) !== 1) {
        throw new Error(`Order ${orderId} has no pending payment to confirm`);
      }

      const order = await client.query<{ order_number: string; user_id: string }>(
        `UPDATE "order".orders
         SET status = 'confirmed', payment_status = 'paid', updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING order_number, user_id;`,
        [orderId],
      );
      if (order.rows.length === 0) {
        throw new Error(`Order ${orderId} is no longer pending`);
      }

      const { order_number: orderNumber, user_id: userId } = order.rows[0];

      await client.query(
        `INSERT INTO "order".order_status_history (
          order_id, from_status, to_status, note, actor
        ) VALUES ($1, 'pending', 'confirmed', $2, $3);`,
        [orderId, 'Payment captured', userId],
      );

      if (outbox) {
        await this.outbox.recordOrderCreated(client, outbox, {
          orderId,
          orderNumber,
        });
      }

      await client.query('COMMIT');
      return { orderId, orderNumber };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Closes a pending attempt that will never be paid: the order becomes
   * `failed`, the payment records why, and the history says so. Returns false
   * when the order was already settled, so a compensation replay is harmless.
   */
  async failOrder(
    orderId: string,
    note: string,
    paymentStatus: 'failed' | 'refunded',
  ): Promise<boolean> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const order = await client.query<{ user_id: string }>(
        `UPDATE "order".orders
         SET status = 'failed', payment_status = $2, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING user_id;`,
        [orderId, paymentStatus === 'refunded' ? 'refunded' : 'failed'],
      );

      if (order.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO "order".order_status_history (
          order_id, from_status, to_status, note, actor
        ) VALUES ($1, 'pending', 'failed', $2, $3);`,
        [orderId, note, order.rows[0].user_id],
      );

      await client.query(
        `UPDATE "order".payments
         SET status = $2, updated_at = now()
         WHERE order_id = $1 AND status = 'pending';`,
        [orderId, paymentStatus],
      );

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function constraintOf(error: unknown): string | undefined {
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}
