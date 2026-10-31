import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getPool, closePool } from '../src/db/pool.js';
import type {
  OrderRow,
  OrderItemRow,
  DiscountCodeRow,
  PaymentRow,
  OutboxRow,
} from '../src/db/rows.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Order Schema & Fixtures (e2e)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = getPool();

    // Every migration in filename order: a new db/NNN file has to reach this spec
    // without an edit here, otherwise the schema assertions silently go stale.
    const dbDir = join(__dirname, '../db');
    const migrations = readdirSync(dbDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations) {
      await pool.query(readFileSync(join(dbDir, migration), 'utf-8'));
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('proves all 8 tables exist in schema "order"', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'order' 
       ORDER BY table_name;`,
    );

    const tables = rows.map((r) => r.table_name);
    expect(tables).toContain('orders');
    expect(tables).toContain('order_items');
    expect(tables).toContain('order_status_history');
    expect(tables).toContain('payments');
    expect(tables).toContain('outbox');
    expect(tables).toContain('discount_codes');
    expect(tables).toContain('shipments');
    expect(tables).toContain('refunds');
  });

  it('guards one refund per order with a unique order_id', async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'order' AND tablename = 'refunds';`,
    );
    expect(rows.length).toBeGreaterThan(0);

    const constraints = await pool.query<{ constraint_type: string }>(
      `SELECT constraint_type FROM information_schema.table_constraints
       WHERE table_schema = 'order' AND table_name = 'refunds'
         AND constraint_type = 'UNIQUE';`,
    );
    expect(constraints.rows.length).toBe(1);
  });

  it('verifies seed discount codes exist with expected constraints', async () => {
    const { rows } = await pool.query<DiscountCodeRow>(
      `SELECT * FROM "order".discount_codes ORDER BY code;`,
    );

    const codes = rows.map((r) => r.code);
    expect(codes).toContain('SAVE10');
    expect(codes).toContain('FLAT20');
    expect(codes).toContain('EXPIRED50');
    expect(codes).toContain('MAXEDOUT');
    expect(codes).toContain('DISABLED5');

    const save10 = rows.find((r) => r.code === 'SAVE10');
    expect(save10?.discount_type).toBe('percent');
    expect(parseFloat(save10?.value ?? '0')).toBe(10);
    expect(save10?.is_active).toBe(true);

    const flat20 = rows.find((r) => r.code === 'FLAT20');
    expect(flat20?.discount_type).toBe('fixed');
    expect(parseFloat(flat20?.min_order_amount ?? '0')).toBe(50);
  });

  it('enforces percentage discount cannot exceed 100%', async () => {
    await expect(
      pool.query(
        `INSERT INTO "order".discount_codes (code, discount_type, value)
         VALUES ('INVALID150', 'percent', 150.00);`,
      ),
    ).rejects.toThrow();
  });

  it('enforces unique constraint on discount code', async () => {
    await expect(
      pool.query(
        `INSERT INTO "order".discount_codes (code, discount_type, value)
         VALUES ('SAVE10', 'percent', 15.00);`,
      ),
    ).rejects.toThrow();
  });

  it('verifies seed order, items, status history, and payment linkage', async () => {
    const orderRes = await pool.query<OrderRow>(
      `SELECT * FROM "order".orders WHERE order_number = '#2026-000001';`,
    );
    expect(orderRes.rows.length).toBe(1);
    const order = orderRes.rows[0];
    expect(order.status).toBe('confirmed');
    expect(order.payment_status).toBe('paid');
    expect(parseFloat(order.grand_total)).toBe(148.98);

    const itemsRes = await pool.query<OrderItemRow>(
      `SELECT * FROM "order".order_items WHERE order_id = $1;`,
      [order.id],
    );
    expect(itemsRes.rows.length).toBe(1);
    expect(itemsRes.rows[0].sku).toBe('RSX-S-RED');
    expect(itemsRes.rows[0].qty).toBe(2);

    const payRes = await pool.query<PaymentRow>(
      `SELECT * FROM "order".payments WHERE order_id = $1;`,
      [order.id],
    );
    expect(payRes.rows.length).toBe(1);
    expect(payRes.rows[0].transaction_id).toBe('mock_tx_000001');
    expect(payRes.rows[0].status).toBe('captured');
  });

  it('enforces CASCADE deletion from orders to items, history, and payments', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertOrder = await client.query<OrderRow>(
        `INSERT INTO "order".orders (
          user_id, order_number, status, subtotal, grand_total, shipping_address, billing_address
        ) VALUES (
          gen_random_uuid(), '#TEMP-CASCADE', 'pending', 50.00, 50.00,
          '{"line1": "Test"}', '{"line1": "Test"}'
        ) RETURNING id;`,
      );
      const tempId = insertOrder.rows[0].id;

      await client.query(
        `INSERT INTO "order".order_items (order_id, product_id, product_name, sku, unit_price, qty, line_total)
         VALUES ($1, gen_random_uuid(), 'Temp', 'SKU-TEMP', 50.00, 1, 50.00);`,
        [tempId],
      );

      await client.query(
        `INSERT INTO "order".order_status_history (order_id, to_status, actor)
         VALUES ($1, 'pending', 'test');`,
        [tempId],
      );

      // Verify inserted
      const countBefore = await client.query(
        `SELECT count(*) FROM "order".order_items WHERE order_id = $1;`,
        [tempId],
      );
      expect(parseInt(countBefore.rows[0].count, 10)).toBe(1);

      // Delete parent order
      await client.query(`DELETE FROM "order".orders WHERE id = $1;`, [tempId]);

      // Items and history should be cascaded
      const countAfter = await client.query(
        `SELECT count(*) FROM "order".order_items WHERE order_id = $1;`,
        [tempId],
      );
      expect(parseInt(countAfter.rows[0].count, 10)).toBe(0);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('triggers set_updated_at() on order update', async () => {
    const { rows: initial } = await pool.query<OrderRow>(
      `SELECT id, updated_at FROM "order".orders WHERE order_number = '#2026-000001';`,
    );
    const initialUpdatedAt = new Date(initial[0].updated_at).getTime();

    // Small delay to ensure timestamp moves forward
    await new Promise((r) => setTimeout(r, 50));

    await pool.query(
      `UPDATE "order".orders SET notes = 'Updated note test' WHERE id = $1;`,
      [initial[0].id],
    );

    const { rows: updated } = await pool.query<OrderRow>(
      `SELECT updated_at FROM "order".orders WHERE id = $1;`,
      [initial[0].id],
    );
    const updatedTime = new Date(updated[0].updated_at).getTime();

    expect(updatedTime).toBeGreaterThan(initialUpdatedAt);
  });

  it('supports transactional outbox insertion with pending status', async () => {
    const eventId = randomUUID();
    const orderId = '018f0000-0000-7000-8000-000000000010';

    // ord-011: a pending row has to carry the canonical envelope. `payload` is
    // still there for the rows written before migration 006, and new rows leave
    // it null.
    await pool.query(
      `INSERT INTO "order".outbox (
        event_id, aggregate_type, aggregate_id, event_type, envelope
      ) VALUES ($1, 'order', $2, 'order.created', $3::jsonb);`,
      [
        eventId,
        orderId,
        JSON.stringify({
          id: eventId,
          type: 'order.created',
          payload: {
            orderId,
            orderNumber: '#2026-900001',
            userId: '018f0000-0000-7000-8000-000000000001',
            grandTotal: 10,
            itemsCount: 1,
            reservationId: '',
            createdAt: '2026-10-31T00:00:00.000Z',
          },
        }),
      ],
    );

    const { rows } = await pool.query<OutboxRow>(
      `SELECT * FROM "order".outbox WHERE event_id = $1;`,
      [eventId],
    );

    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].published_at).toBeNull();
    expect(rows[0].payload).toBeNull();
    expect(rows[0].envelope).toMatchObject({ id: eventId, type: 'order.created' });

    await pool.query(`DELETE FROM "order".outbox WHERE event_id = $1;`, [eventId]);
  });

  it('rejects a pending outbox row that has no envelope', async () => {
    const eventId = randomUUID();

    await expect(
      pool.query(
        `INSERT INTO "order".outbox (
          event_id, aggregate_type, aggregate_id, event_type, payload
        ) VALUES ($1, 'order', '018f0000-0000-7000-8000-000000000010', 'order.created', '{"test": true}');`,
        [eventId],
      ),
    ).rejects.toThrow(/outbox_pending_has_envelope/);
  });
});
