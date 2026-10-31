import { Injectable, NotFoundException } from '@nestjs/common';
import { getPool } from '../db/pool.js';
import { OrderOutbox } from '../outbox/order-outbox.js';
import type { OrderRow, PaymentRow, RefundRow } from '../db/rows.js';

export interface StartRefundInput {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string | null;
  requestedBy: string;
}

export interface RefundSettlement {
  refund: RefundRow;
  order: OrderRow;
}

/**
 * The refunds ledger: one row per order is the contract with the provider, the
 * idempotency gate and the retry slot, so a transaction sits on each side of the
 * provider call — one to reserve the slot, one to settle it.
 */
@Injectable()
export class RefundsRepository {
  constructor(private readonly outbox: OrderOutbox) {}

  async findByOrderId(orderId: string): Promise<RefundRow | null> {
    const { rows } = await getPool().query<RefundRow>(
      `SELECT * FROM "order".refunds WHERE order_id = $1 LIMIT 1;`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /**
   * The payment a refund has to reverse. A payment without a transaction id was
   * never captured, so there is nothing to send back.
   */
  async findCapturedPayment(orderId: string): Promise<PaymentRow | null> {
    const { rows } = await getPool().query<PaymentRow>(
      `SELECT * FROM "order".payments
       WHERE order_id = $1 AND status = 'captured' AND transaction_id IS NOT NULL
       ORDER BY created_at
       LIMIT 1;`,
      [orderId],
    );
    return rows[0] ?? null;
  }

  /**
   * Reserves the refund slot *before* the provider is called. `UNIQUE (order_id)`
   * settles a concurrent double-click: the loser gets the existing row back with
   * `created: false` instead of a second refund.
   */
  async startRefund(
    input: StartRefundInput,
  ): Promise<{ refund: RefundRow; created: boolean }> {
    const { rows } = await getPool().query<RefundRow>(
      `INSERT INTO "order".refunds (
        order_id, payment_id, amount, status, reason, requested_by
      ) VALUES ($1, $2, $3, 'pending', $4, $5)
      ON CONFLICT DO NOTHING
      RETURNING *;`,
      [input.orderId, input.paymentId, input.amount, input.reason, input.requestedBy],
    );

    const inserted = rows[0];
    if (inserted) return { refund: inserted, created: true };

    const existing = await this.findByOrderId(input.orderId);
    if (!existing) {
      throw new Error(`Refund for order ${input.orderId} was not recorded`);
    }
    return { refund: existing, created: false };
  }

  /**
   * The provider returned the money: ledger, payment, order, history and the
   * canonical `order.status.updated` event commit together or not at all.
   */
  async markSucceeded(
    refundId: string,
    providerReference: string,
  ): Promise<RefundSettlement> {
    const client = await getPool().connect();

    try {
      await client.query('BEGIN');

      const refundRes = await client.query<RefundRow>(
        `UPDATE "order".refunds
         SET status = 'succeeded', provider_reference = $2, failure_reason = NULL,
             updated_at = now()
         WHERE id = $1
         RETURNING *;`,
        [refundId, providerReference],
      );

      const refund = refundRes.rows[0];
      if (!refund) throw new NotFoundException(`Refund ${refundId} not found`);

      await client.query(
        `UPDATE "order".payments
         SET status = 'refunded', updated_at = now()
         WHERE id = $1;`,
        [refund.payment_id],
      );

      // `from` has to be the status the order is leaving, so read it under the
      // same lock that the update takes.
      const current = await client.query<OrderRow>(
        `SELECT * FROM "order".orders WHERE id = $1 FOR UPDATE;`,
        [refund.order_id],
      );
      const previousStatus = current.rows[0]?.status;
      if (!previousStatus) {
        throw new NotFoundException(`Order ${refund.order_id} not found`);
      }

      const orderRes = await client.query<OrderRow>(
        `UPDATE "order".orders
         SET status = 'refunded', payment_status = 'refunded', updated_at = now()
         WHERE id = $1
         RETURNING *;`,
        [refund.order_id],
      );
      const order = orderRes.rows[0];

      await client.query(
        `INSERT INTO "order".order_status_history (
          order_id, from_status, to_status, note, actor
        ) VALUES ($1, $2, 'refunded', $3, $4);`,
        [
          order.id,
          previousStatus,
          refund.reason ? `Refund: ${refund.reason}` : 'Order refunded',
          refund.requested_by,
        ],
      );

      await this.outbox.recordStatusUpdated(client, {
        orderId: order.id,
        orderNumber: order.order_number,
        from: previousStatus,
        to: 'refunded',
        refundAmount: refund.amount,
        refundReference: providerReference,
        actor: refund.requested_by,
        timestamp: new Date().toISOString(),
      });

      await client.query('COMMIT');
      return { refund, order };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * The provider refused or was unreachable: only the ledger row changes, so the
   * order stays exactly where it was and a retry can reuse this slot.
   */
  async markFailed(refundId: string, failureReason: string): Promise<RefundRow> {
    const { rows } = await getPool().query<RefundRow>(
      `UPDATE "order".refunds
       SET status = 'failed', failure_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING *;`,
      [refundId, failureReason.slice(0, 500)],
    );

    if (!rows[0]) throw new NotFoundException(`Refund ${refundId} not found`);
    return rows[0];
  }
}
