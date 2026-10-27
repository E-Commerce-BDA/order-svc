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
import { OutboxService } from '../src/outbox/outbox.service.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OrderRow } from '../src/db/rows.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Orders Lifecycle & State Machine (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let outboxService: OutboxService;
  let customerToken: string;
  let otherCustomerToken: string;
  let adminToken: string;

  const customerId = '018f0000-0000-7000-8000-000000000001';
  const otherCustomerId = '018f0000-0000-7000-8000-000000000002';
  const adminId = '018f0000-0000-7000-8000-000000000099';
  let createdOrderId: string;

  beforeAll(async () => {
    const pool = getPool();
    const schemaSql = readFileSync(
      join(__dirname, '../db/001-order-schema.sql'),
      'utf-8',
    );
    await pool.query(schemaSql);
    const seedSql = readFileSync(
      join(__dirname, '../db/002-seed-orders.sql'),
      'utf-8',
    );
    await pool.query(seedSql);

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
    outboxService = app.get(OutboxService);
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
      [createdOrderId, `tx_test_${randomUUID().slice(0, 8)}`],
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
    it('customer cannot issue refund (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ reason: 'Give me money' })
        .expect(403);
    });

    it('rejects refund amount exceeding grand total with 400 Bad Request', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 500.0, reason: 'Too much' })
        .expect(400);

      expect(res.body.message).toContain('exceeds order grand total');
    });

    it('admin processes refund on delivered order', async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/v1/orders/${createdOrderId}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Customer returned item within 30-day window' })
        .expect(200);

      expect(res.body.order.status).toBe('refunded');
      expect(res.body.order.payment_status).toBe('refunded');
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

  describe('Outbox Relay Worker Verification', () => {
    it('processes pending outbox rows and marks them published', async () => {
      const pool = getPool();
      const countRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "order".outbox WHERE status = 'pending';`,
      );
      const pendingCount = parseInt(countRes.rows[0].count, 10);
      expect(pendingCount).toBeGreaterThan(0);

      const processed = await outboxService.processPendingEvents(50);
      expect(processed).toBeGreaterThanOrEqual(pendingCount);

      const remainingRes = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "order".outbox WHERE status = 'pending';`,
      );
      expect(parseInt(remainingRes.rows[0].count, 10)).toBe(0);
    });
  });
});
