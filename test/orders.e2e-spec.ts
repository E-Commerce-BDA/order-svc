import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from '../src/auth/auth.constants.js';
import { closePool, getPool } from '../src/db/pool.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { vi, type MockInstance } from 'vitest';
import { MockPaymentProvider } from '../src/payments/mock-payment.provider.js';
import type { OrderRow, PaymentRow, RefundRow } from '../src/db/rows.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Orders Lifecycle & State Machine (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let customerToken: string;
  let otherCustomerToken: string;
  let adminToken: string;

  const customerId = '018f0000-0000-7000-8000-000000000001';
  const otherCustomerId = '018f0000-0000-7000-8000-000000000002';
  const adminId = '018f0000-0000-7000-8000-000000000099';
  let createdOrderId: string;
  let refundFailureOrderId: string;
  let uncapturedOrderId: string;
  const createdPaymentTx = `tx_test_${randomUUID().slice(0, 8)}`;

  /**
   * A delivered order plus its payment, so the refund cases do not have to replay
   * the whole administrative lifecycle to get there.
   */
  const seedDeliveredOrder = async (
    orderId: string,
    orderNumber: string,
    paymentStatus: 'captured' | 'pending',
  ): Promise<void> => {
    const pool = getPool();
    await pool.query(
      `INSERT INTO "order".orders (
        id, user_id, order_number, status, subtotal, shipping_fee, tax, discount, grand_total,
        currency, payment_status, shipping_address, billing_address
      ) VALUES (
        $1, $2, $3, 'delivered', '100.00', '10.00', '8.00', '0.00', '118.00',
        'USD', $4, '{"line1":"123 Main St"}', '{"line1":"123 Main St"}'
      );`,
      [
        orderId,
        customerId,
        orderNumber,
        paymentStatus === 'captured' ? 'paid' : 'pending',
      ],
    );

    const transactionId =
      paymentStatus === 'captured' ? `tx_refund_${orderId.slice(0, 8)}` : null;

    await pool.query(
      `INSERT INTO "order".payments (
        order_id, provider, amount, status, transaction_id, paid_at
      ) VALUES ($1, 'mock', '118.00', $2, $3, $4);`,
      [
        orderId,
        paymentStatus,
        transactionId,
        transactionId ? new Date().toISOString() : null,
      ],
    );
  };

  beforeAll(async () => {
    const pool = getPool();
    // Apply every migration in filename order, so a new db/NNN file is picked up
    // without editing this bootstrap.
    const dbDir = join(__dirname, '../db');
    const migrations = readdirSync(dbDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations) {
      await pool.query(readFileSync(join(dbDir, migration), 'utf-8'));
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    jwtService = app.get(JwtService);
    const configService = app.get(ConfigService);
    const secret = configService.getOrThrow<string>('JWT_SECRET');

    customerToken = await jwtService.signAsync(
      { sub: customerId, email: 'customer@example.com', roles: ['customer'] },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    otherCustomerToken = await jwtService.signAsync(
      { sub: otherCustomerId, email: 'other@example.com', roles: ['customer'] },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    adminToken = await jwtService.signAsync(
      { sub: adminId, email: 'admin@example.com', roles: ['admin'] },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    // Insert an initial active order for testing
    createdOrderId = randomUUID();
    await pool.query(
      `INSERT INTO "order".orders (
        id, user_id, order_number, status, subtotal, shipping_fee, tax, discount, grand_total,
        currency, payment_status, shipping_address, billing_address
      ) VALUES (
        $1, $2, $3, 'confirmed', '100.00', '10.00', '8.00', '0.00', '118.00',
        'USD', 'paid', '{"line1":"123 Main St","city":"NYC","postalCode":"10001","country":"US"}',
        '{"line1":"123 Main St","city":"NYC","postalCode":"10001","country":"US"}'
      );`,
      [createdOrderId, customerId, `#TEST-${createdOrderId.slice(0, 6)}`],
    );

    await pool.query(
      `INSERT INTO "order".order_items (
        order_id, product_id, product_name, sku, unit_price, qty, line_total
      ) VALUES (
        $1, '018f0000-0000-7000-8000-000000000101', 'Test Widget', 'WIDGET-01', '50.00', 2, '100.00'
      );`,
      [createdOrderId],
    );

    await pool.query(
      `INSERT INTO "order".order_status_history (
        order_id, from_status, to_status, note, actor
      ) VALUES ($1, null, 'confirmed', 'Order created', $2);`,
      [createdOrderId, customerId],
    );

    await pool.query(
      `INSERT INTO "order".payments (
        order_id, provider, amount, status, transaction_id, paid_at
      ) VALUES ($1, 'mock', '118.00', 'captured', $2, now());`,
      [createdOrderId, createdPaymentTx],
    );

    // Two refund fixtures: one whose provider call will be refused, and one that
    // was never paid for. Both start delivered, so the FSM lets a refund through.
    refundFailureOrderId = randomUUID();
    await seedDeliveredOrder(
      refundFailureOrderId,
      `#TEST-RF-${refundFailureOrderId.slice(0, 6)}`,
      'captured',
    );

    uncapturedOrderId = randomUUID();
    await seedDeliveredOrder(
      uncapturedOrderId,
      `#TEST-NP-${uncapturedOrderId.slice(0, 6)}`,
      'pending',
    );
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('Customer Order History (GET /me/orders & GET /orders/me)', () => {
    it('customer retrieves their own order list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/me/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      const myOrder = res.body.data.find(
        (o: OrderRow) => o.id === createdOrderId,
      );
      expect(myOrder).toBeDefined();
      expect(myOrder.items).toHaveLength(1);
      expect(myOrder.items[0].product_name).toBe('Test Widget');
    });

    it('other customer cannot see the order in their history list', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/me')
        .set('Authorization', `Bearer ${otherCustomerToken}`)
        .expect(200);

      const found = res.body.data.find(
        (o: OrderRow) => o.id === createdOrderId,
      );
      expect(found).toBeUndefined();
    });

    it('requires JWT authorization', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/me/orders')
        .expect(401);
    });
  });

  describe('Order Lookup By ID (GET /orders/:id)', () => {
    it('owner customer can view their order', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(res.body.order).toBeDefined();
      expect(res.body.order.id).toBe(createdOrderId);
      expect(res.body.order.items).toHaveLength(1);
      expect(res.body.order.payments).toHaveLength(1);
    });

    it('unauthorized customer receives 403 Forbidden for cross-user order', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${otherCustomerToken}`)
        .expect(403);
    });

    it('admin can view any customer order', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${createdOrderId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.order.id).toBe(createdOrderId);
    });

    it('returns 404 Not Found for non-existent order ID', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/orders/018f0000-0000-7000-8000-999999999999')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('Order Status Lifecycle & State Machine (PATCH /orders/:id/status)', () => {
    it('customer cannot update order status (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ status: 'processing' })
        .expect(403);
    });

    it('admin transitions confirmed -> processing', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'processing', note: 'Order packed in warehouse' })
        .expect(200);

      expect(res.body.order.status).toBe('processing');
    });

    it('admin transitions processing -> shipped', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'shipped', note: 'Carrier dispatched tracking #TRK123' })
        .expect(200);

      expect(res.body.order.status).toBe('shipped');
    });

    it('admin transitions shipped -> delivered', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'delivered', note: 'Delivered to front porch' })
        .expect(200);

      expect(res.body.order.status).toBe('delivered');
    });

    it('rejects invalid state rollback delivered -> confirmed with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/api/v1/orders/${createdOrderId}/status`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'confirmed' })
        .expect(400);

      expect(res.body.message).toContain('Invalid order status transition');
    });
  });

  describe('Order Status History Timeline (GET /orders/:id/status-history)', () => {
    it('admin retrieves complete chronological history timeline', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/orders/${createdOrderId}/status-history`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.history).toBeDefined();
      expect(res.body.history.length).toBeGreaterThanOrEqual(4);
      const statuses = res.body.history.map((h: { to_status: string }) => h.to_status);
      expect(statuses).toContain('confirmed');
      expect(statuses).toContain('processing');
      expect(statuses).toContain('shipped');
      expect(statuses).toContain('delivered');
    });
  });

  describe('Order Refund (POST /orders/:id/refund)', () => {
    let providerRefund: MockInstance<MockPaymentProvider['refund']>;

    // The provider is the only component that actually moves money, so every case
    // asserts on it rather than on the HTTP status alone.
    beforeEach(() => {
      providerRefund = vi.spyOn(app.get(MockPaymentProvider), 'refund');
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('customer cannot issue refund (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ reason: 'Give me money' })
        .expect(403);

      expect(providerRefund).not.toHaveBeenCalled();
    });

    it('rejects refund amount exceeding grand total with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 500.0, reason: 'Too much' })
        .expect(400);

      expect(res.body.message).toContain('exceeds order grand total');
      expect(providerRefund).not.toHaveBeenCalled();
    });

    it('refunds through the provider and writes one canonical status event', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Customer returned item within 30-day window' })
        .expect(200);

      expect(res.body.order.status).toBe('refunded');
      expect(res.body.order.payment_status).toBe('refunded');
      expect(res.body.refund.status).toBe('succeeded');
      expect(res.body.refund.provider_reference).toMatch(/^mock_ref_/);

      // The provider has to see the transaction we captured, not the order id.
      expect(providerRefund).toHaveBeenCalledTimes(1);
      expect(providerRefund).toHaveBeenCalledWith(
        createdPaymentTx,
        118,
        'Customer returned item within 30-day window',
      );

      const pool = getPool();
      const refundRows = await pool.query<RefundRow>(
        `SELECT * FROM "order".refunds WHERE order_id = $1;`,
        [createdOrderId],
      );
      expect(refundRows.rows).toHaveLength(1);
      expect(refundRows.rows[0].status).toBe('succeeded');
      expect(refundRows.rows[0].provider_reference).toBe(
        res.body.refund.provider_reference,
      );
      expect(parseFloat(refundRows.rows[0].amount)).toBe(118);

      const payment = await pool.query<PaymentRow>(
        `SELECT * FROM "order".payments WHERE order_id = $1;`,
        [createdOrderId],
      );
      expect(payment.rows[0].status).toBe('refunded');

      const events = await pool.query<{
        event_type: string;
        envelope: { payload: Record<string, unknown> } | null;
      }>(
        `SELECT event_type, envelope FROM "order".outbox WHERE aggregate_id = $1;`,
        [createdOrderId],
      );
      // Migration 006 leaves `payload` null: the envelope is what the relay sends.
      const refundEvent = events.rows.find(
        (row) => row.envelope?.payload?.to === 'refunded',
      );
      expect(refundEvent?.event_type).toBe('order.status.updated');
      expect(refundEvent?.envelope?.payload).toMatchObject({
        orderId: createdOrderId,
        from: 'delivered',
        to: 'refunded',
        refundAmount: '118.00',
        actor: adminId,
      });

      // Scoped to this aggregate: older runs left `order.refunded` rows behind, and
      // the point is that *this* refund did not add another one.
      const legacy = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "order".outbox
         WHERE aggregate_id = $1 AND event_type = 'order.refunded';`,
        [createdOrderId],
      );
      expect(legacy.rows[0].count).toBe('0');
    });

    it('replays a settled refund without calling the provider again', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Called twice by mistake' })
        .expect(200);

      expect(res.body.refund.status).toBe('succeeded');
      expect(providerRefund).not.toHaveBeenCalled();

      const { rows } = await getPool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "order".refunds WHERE order_id = $1;`,
        [createdOrderId],
      );
      expect(rows[0].count).toBe('1');
    });

    it('leaves the order and the payment untouched when the provider fails', async () => {
      providerRefund.mockResolvedValueOnce({
        success: false,
        errorMessage: 'Refund window closed',
      });

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${refundFailureOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Customer asked twice' })
        .expect(502);

      expect(res.body.code).toBe('REFUND_PROVIDER_FAILED');
      expect(res.body.message).toBe('Refund window closed');

      const pool = getPool();
      const refundRows = await pool.query<RefundRow>(
        `SELECT * FROM "order".refunds WHERE order_id = $1;`,
        [refundFailureOrderId],
      );
      expect(refundRows.rows).toHaveLength(1);
      expect(refundRows.rows[0].status).toBe('failed');
      expect(refundRows.rows[0].failure_reason).toBe('Refund window closed');

      // The money never left: the order keeps its status and the payment stays
      // captured, because a failed refund has to remain retryable.
      const order = await pool.query<OrderRow>(
        `SELECT * FROM "order".orders WHERE id = $1;`,
        [refundFailureOrderId],
      );
      expect(order.rows[0].status).toBe('delivered');

      const payment = await pool.query<PaymentRow>(
        `SELECT * FROM "order".payments WHERE order_id = $1;`,
        [refundFailureOrderId],
      );
      expect(payment.rows[0].status).toBe('captured');
    });

    it('retries a failed refund on the same ledger row', async () => {
      const before = await getPool().query<RefundRow>(
        `SELECT * FROM "order".refunds WHERE order_id = $1;`,
        [refundFailureOrderId],
      );
      expect(before.rows[0].status).toBe('failed');

      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${refundFailureOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Second attempt' })
        .expect(200);

      expect(res.body.refund.id).toBe(before.rows[0].id);
      expect(res.body.refund.status).toBe('succeeded');
      expect(providerRefund).toHaveBeenCalledTimes(1);
      // The retry reuses the reserved amount and the reason it was reserved with.
      expect(providerRefund).toHaveBeenCalledWith(
        expect.stringMatching(/^tx_refund_/),
        118,
        'Customer asked twice',
      );
    });

    it('refuses a refund when no payment was captured', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${uncapturedOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Nothing was ever paid' })
        .expect(409);

      expect(res.body.code).toBe('NO_CAPTURED_PAYMENT');
      expect(providerRefund).not.toHaveBeenCalled();
    });
  });

  describe('Admin Order Query (GET /orders)', () => {
    it('admin lists orders filtered by status refunded', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders?status=refunded')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(res.body.total).toBeGreaterThanOrEqual(1);
      const refunded = res.body.data.find(
        (o: OrderRow) => o.id === createdOrderId,
      );
      expect(refunded).toBeDefined();
      expect(refunded.status).toBe('refunded');
    });
  });
});
