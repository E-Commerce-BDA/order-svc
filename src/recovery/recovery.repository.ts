import { Injectable } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import { OrderOutbox, type OrderCreatedWrite } from '../outbox/order-outbox.js';
import type { PaymentProvider } from '../db/rows.js';

/** One sweep per process fleet, the same advisory-lock key on every instance. */
const SWEEP_LOCK_KEY = 'order.recovery';

export interface StalePendingCapture {
  orderId: string;
  orderNumber: string;
  userId: string;
  grandTotal: number;
  itemsCount: number;
  reservationId: string | null;
  createdAt: string;
  paymentId: string;
  provider: PaymentProvider;
  paymentStatus: 'pending' | 'captured';
  transactionId: string | null;
}

export interface StuckRefund {
  refundId: string;
  amount: number;
  reason: string | null;
  transactionId: string;
}

/**
 * Reads and terminal writes for the recovery sweep.
 *
 * There is no lease column to add: the session advisory lock elects one
 * sweeper for the whole fleet, and every terminal write is guarded on the row
 * still being in the state it was read in. A provider call therefore happens
 * outside a database transaction, while exactly-once settlement stays in the
 * database where it can be enforced.
 */
@Injectable()
export class RecoveryRepository {
  constructor(private readonly outbox: OrderOutbox) {}

  /**
   * Mirrors the outbox relay's leader lock. The release always unlocks before
   * returning the connection: an advisory lock is session-scoped, so a client
   * handed back still holding it would block every future sweep.
   */
  async tryAcquireSweepLock(): Promise<(() => Promise<void>) | null> {
    const client = await getPool().connect();
    let acquired = false;

    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [SWEEP_LOCK_KEY],
      );
      acquired = rows[0]?.locked === true;
    } catch (error) {
      client.release();
      throw error;
    }

    if (!acquired) {
      client.release();
      return null;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;

      try {
        await client.query(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
          [SWEEP_LOCK_KEY],
        );
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    };
  }

  /**
   * Orders whose capture was backdated: the row is still pending past the stale
   * cutoff. A captured payment with no confirmed order means TX2 was lost; a
   * pending payment means the provider's answer was lost. Both are reclaimable.
   */
  async findStalePendingCaptures(
    cutoff: Date,
    limit: number,
  ): Promise<StalePendingCapture[]> {
    const { rows } = await getPool().query<{
      order_id: string;
      order_number: string;
      user_id: string;
      grand_total: number;
      items_count: number;
      stock_reservation_id: string | null;
      created_at: Date | string;
      payment_id: string;
      provider: PaymentProvider;
      payment_status: 'pending' | 'captured';
      transaction_id: string | null;
    }>(
      `SELECT o.id AS order_id, o.order_number, o.user_id, o.grand_total,
              o.stock_reservation_id, o.created_at,
              p.id AS payment_id, p.provider, p.status AS payment_status,
              p.transaction_id,
              (SELECT count(*)::int FROM "order".order_items i
                WHERE i.order_id = o.id) AS items_count
         FROM "order".orders o
         JOIN "order".payments p ON p.order_id = o.id
        WHERE o.status = 'pending'
          AND o.created_at <= $1
          AND p.status IN ('pending', 'captured')
          AND NOT EXISTS (
            SELECT 1 FROM "order".refunds r WHERE r.order_id = o.id
          )
        ORDER BY o.created_at, o.id
        LIMIT $2;`,
      [cutoff, limit],
    );

    return rows.map((row) => ({
      orderId: row.order_id,
      orderNumber: row.order_number,
      userId: row.user_id,
      grandTotal: row.grand_total,
      itemsCount: row.items_count,
      reservationId: row.stock_reservation_id,
      createdAt: new Date(row.created_at).toISOString(),
      paymentId: row.payment_id,
      provider: row.provider,
      paymentStatus: row.payment_status,
      transactionId: row.transaction_id,
    }));
  }

  /** Refunds that never left `pending`, so the endpoint keeps answering 409. */
  async findStuckRefunds(cutoff: Date, limit: number): Promise<StuckRefund[]> {
    const { rows } = await getPool().query<{
      id: string;
      amount: number;
      reason: string | null;
      transaction_id: string;
    }>(
      `SELECT r.id, r.amount, r.reason, p.transaction_id
         FROM "order".refunds r
         JOIN "order".payments p ON p.id = r.payment_id
        WHERE r.status = 'pending'
          AND r.updated_at <= $1
          AND p.transaction_id IS NOT NULL
        ORDER BY r.updated_at, r.id
        LIMIT $2;`,
      [cutoff, limit],
    );

    return rows.map((row) => ({
      refundId: row.id,
      amount: row.amount,
      reason: row.reason,
      transactionId: row.transaction_id,
    }));
  }

  /**
   * TX2 for a reclaimed capture. The order must still be pending, so a retry or
   * an admin action that settled it first makes this a no-op. The event keeps
   * the original creation time instead of the moment the sweep ran.
   */
  async confirmReclaimedCapture(
    capture: StalePendingCapture,
    transactionId: string,
  ): Promise<boolean> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const current = await client.query<{ order_number: string; user_id: string }>(
        `SELECT order_number, user_id FROM "order".orders
          WHERE id = $1 AND status = 'pending' FOR UPDATE;`,
        [capture.orderId],
      );
      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `UPDATE "order".payments
            SET status = 'captured', transaction_id = $2, paid_at = now(),
                updated_at = now()
          WHERE order_id = $1 AND status IN ('pending', 'captured');`,
        [capture.orderId, transactionId],
      );

      await client.query(
        `UPDATE "order".orders
            SET status = 'confirmed', payment_status = 'paid', updated_at = now()
          WHERE id = $1 AND status = 'pending';`,
        [capture.orderId],
      );

      await client.query(
        `INSERT INTO "order".order_status_history (
           order_id, from_status, to_status, note, actor
         ) VALUES ($1, 'pending', 'confirmed', $2, $3);`,
        [
          capture.orderId,
          'Payment captured; reclaimed by recovery sweep',
          'system',
        ],
      );

      const { order_number: orderNumber, user_id: userId } = current.rows[0];
      const write: OrderCreatedWrite = {
        topic: 'order.created',
        payload: () => ({
          orderId: capture.orderId,
          orderNumber,
          userId,
          grandTotal: capture.grandTotal,
          itemsCount: capture.itemsCount,
          reservationId: capture.reservationId ?? '',
          createdAt: capture.createdAt,
        }),
      };
      await this.outbox.recordOrderCreated(
        client,
        write,
        { orderId: capture.orderId, orderNumber },
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

  /** A declined recovery capture closes the attempt instead of leaving it stuck. */
  async closeReclaimedAttempt(orderId: string, note: string): Promise<boolean> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const order = await client.query<{ user_id: string }>(
        `UPDATE "order".orders
            SET status = 'failed', payment_status = 'failed', updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING user_id;`,
        [orderId],
      );
      if (order.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO "order".order_status_history (
           order_id, from_status, to_status, note, actor
         ) VALUES ($1, 'pending', 'failed', $2, $3);`,
        [orderId, note, 'system'],
      );

      await client.query(
        `UPDATE "order".payments
            SET status = 'failed', updated_at = now()
          WHERE order_id = $1 AND status = 'pending';`,
        [orderId],
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
