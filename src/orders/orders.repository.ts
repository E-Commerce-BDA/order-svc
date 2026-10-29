import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import type {
  OrderItemRow,
  OrderRow,
  OrderStatus,
  OrderStatusHistoryRow,
  PaymentRow,
  ShipmentRow,
} from '../db/rows.js';
import type { AdminOrderQueryDto } from './dto/order-query.dto.js';

export interface OrderWithDetails extends OrderRow {
  items: OrderItemRow[];
  status_history: OrderStatusHistoryRow[];
  payments: PaymentRow[];
  shipments?: ShipmentRow[];
}

@Injectable()
export class OrdersRepository {
  /**
   * Loads customer orders with cursor-based pagination.
   */
  async findCustomerOrders(
    userId: string,
    cursor?: string,
    limit = 10,
  ): Promise<{ data: OrderWithDetails[]; nextCursor: string | null }> {
    const pool = getPool();
    const params: unknown[] = [userId];
    let query = `
      SELECT o.*,
        COALESCE(
          (SELECT json_agg(i ORDER BY i.id) FROM "order".order_items i WHERE i.order_id = o.id),
          '[]'::json
        ) AS items,
        COALESCE(
          (SELECT json_agg(h ORDER BY h.created_at ASC) FROM "order".order_status_history h WHERE h.order_id = o.id),
          '[]'::json
        ) AS status_history,
        COALESCE(
          (SELECT json_agg(p ORDER BY p.created_at ASC) FROM "order".payments p WHERE p.order_id = o.id),
          '[]'::json
        ) AS payments
      FROM "order".orders o
      WHERE o.user_id = $1
    `;

    if (cursor) {
      params.push(cursor);
      query += ` AND o.created_at < $${params.length}`;
    }

    params.push(limit + 1);
    query += ` ORDER BY o.created_at DESC LIMIT $${params.length};`;

    const res = await pool.query<OrderWithDetails>(query, params);
    const hasNext = res.rows.length > limit;
    const data = hasNext ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasNext && data.length > 0 ? data[data.length - 1].created_at : null;

    return { data, nextCursor };
  }

  /**
   * Loads an order by its ID with complete relation snapshot.
   */
  async findOrderById(orderId: string): Promise<OrderWithDetails | null> {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(orderId)) {
      return null;
    }

    const pool = getPool();
    const res = await pool.query<OrderWithDetails>(
      `SELECT o.*,
        COALESCE(
          (SELECT json_agg(i ORDER BY i.id) FROM "order".order_items i WHERE i.order_id = o.id),
          '[]'::json
        ) AS items,
        COALESCE(
          (SELECT json_agg(h ORDER BY h.created_at ASC) FROM "order".order_status_history h WHERE h.order_id = o.id),
          '[]'::json
        ) AS status_history,
        COALESCE(
          (SELECT json_agg(p ORDER BY p.created_at ASC) FROM "order".payments p WHERE p.order_id = o.id),
          '[]'::json
        ) AS payments
      FROM "order".orders o
      WHERE o.id = $1;`,
      [orderId],
    );

    return res.rows[0] ?? null;
  }

  /**
   * Loads the status history timeline for a given order.
   */
  async findStatusHistory(orderId: string): Promise<OrderStatusHistoryRow[]> {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_REGEX.test(orderId)) {
      return [];
    }

    const pool = getPool();
    const res = await pool.query<OrderStatusHistoryRow>(
      `SELECT * FROM "order".order_status_history
       WHERE order_id = $1
       ORDER BY created_at ASC;`,
      [orderId],
    );
    return res.rows;
  }

  /**
   * Admin order list with filtering, searching, and pagination.
   */
  async findAdminOrders(queryDto: AdminOrderQueryDto): Promise<{
    data: OrderWithDetails[];
    total: number;
    page: number;
    perPage: number;
  }> {
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (queryDto.status) {
      params.push(queryDto.status);
      conditions.push(`o.status = $${params.length}`);
    }

    if (queryDto.orderNumber) {
      params.push(`%${queryDto.orderNumber}%`);
      conditions.push(`o.order_number ILIKE $${params.length}`);
    }

    if (queryDto.userId) {
      params.push(queryDto.userId);
      conditions.push(`o.user_id = $${params.length}`);
    }

    if (queryDto.from) {
      params.push(queryDto.from);
      conditions.push(`o.created_at >= $${params.length}`);
    }

    if (queryDto.to) {
      params.push(queryDto.to);
      conditions.push(`o.created_at <= $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "order".orders o ${whereClause};`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const page = queryDto.page ?? 1;
    const perPage = queryDto.perPage ?? 20;
    const offset = (page - 1) * perPage;

    params.push(perPage);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const dataRes = await pool.query<OrderWithDetails>(
      `SELECT o.*,
        COALESCE(
          (SELECT json_agg(i ORDER BY i.id) FROM "order".order_items i WHERE i.order_id = o.id),
          '[]'::json
        ) AS items,
        COALESCE(
          (SELECT json_agg(h ORDER BY h.created_at ASC) FROM "order".order_status_history h WHERE h.order_id = o.id),
          '[]'::json
        ) AS status_history,
        COALESCE(
          (SELECT json_agg(p ORDER BY p.created_at ASC) FROM "order".payments p WHERE p.order_id = o.id),
          '[]'::json
        ) AS payments
      FROM "order".orders o
      ${whereClause}
      ORDER BY o.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};`,
      params,
    );

    return {
      data: dataRes.rows,
      total,
      page,
      perPage,
    };
  }

  /**
   * Transactionally updates order status, records history entry, and enqueues outbox event.
   */
  async updateStatusWithHistory(
    orderId: string,
    currentStatus: OrderStatus,
    nextStatus: OrderStatus,
    note: string | null,
    actor: string,
  ): Promise<OrderRow> {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');

      const orderRes = await client.query<OrderRow>(
        `UPDATE "order".orders
         SET status = $1, updated_at = now()
         WHERE id = $2
         RETURNING *;`,
        [nextStatus, orderId],
      );

      if (orderRes.rows.length === 0) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }

      await client.query(
        `INSERT INTO "order".order_status_history (
          order_id, from_status, to_status, note, actor
        ) VALUES ($1, $2, $3, $4, $5);`,
        [orderId, currentStatus, nextStatus, note, actor],
      );

      const outboxPayload = {
        orderId,
        orderNumber: orderRes.rows[0].order_number,
        from: currentStatus,
        to: nextStatus,
        note,
        actor,
        timestamp: new Date().toISOString(),
      };

      await client.query(
        `INSERT INTO "order".outbox (
          event_id, aggregate_type, aggregate_id, event_type, payload
        ) VALUES ($1, $2, $3, $4, $5);`,
        [
          randomUUID(),
          'order',
          orderId,
          'order.status.updated',
          JSON.stringify(outboxPayload),
        ],
      );

      await client.query('COMMIT');
      return orderRes.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
