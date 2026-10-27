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
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { CacheControlInterceptor } from '../src/common/interceptors/cache-control.interceptor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Security, Guards & Envelope (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let customerToken: string;
  let otherCustomerToken: string;
  let adminToken: string;
  let serviceKey: string;
  let sampleOrderId: string;

  const customerId = '018f0000-0000-7000-8000-000000000001';
  const otherCustomerId = '018f0000-0000-7000-8000-000000000002';
  const adminId = '018f0000-0000-7000-8000-000000000099';

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

    // Wire global filter and interceptor identically to main.ts
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new CacheControlInterceptor());

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
    serviceKey = configService.getOrThrow<string>('INTERNAL_SERVICE_KEY');

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

    // Insert order fixture for security tests
    sampleOrderId = randomUUID();
    await pool.query(
      `INSERT INTO "order".orders (
        id, user_id, order_number, status, subtotal, shipping_fee, tax, discount, grand_total,
        currency, payment_status, shipping_address, billing_address
      ) VALUES (
        $1, $2, $3, 'confirmed', '100.00', '10.00', '8.00', '0.00', '118.00',
        'USD', 'paid', '{"line1":"123 Main St","city":"NYC","postalCode":"10001","country":"US"}',
        '{"line1":"123 Main St","city":"NYC","postalCode":"10001","country":"US"}'
      );`,
      [sampleOrderId, customerId, `#SEC-${sampleOrderId.slice(0, 6)}`],
    );

    await pool.query(
      `INSERT INTO "order".order_items (
        order_id, product_id, product_name, sku, unit_price, qty, line_total
      ) VALUES (
        $1, '018f0000-0000-7000-8000-000000000101', 'Secured Widget', 'SEC-WIDGET', '50.00', 2, '100.00'
      );`,
      [sampleOrderId],
    );

    await pool.query(
      `INSERT INTO "order".payments (
        order_id, provider, amount, status, transaction_id, paid_at
      ) VALUES ($1, 'mock', '118.00', 'captured', $2, now());`,
      [sampleOrderId, `tx_sec_${randomUUID().slice(0, 8)}`],
    );
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  describe('Standard Error Envelope & Request Tracing', () => {
    it('returns structured error envelope with matching x-request-id header', async () => {
      const traceId = 'req-sec-trace-12345';
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/018f0000-0000-7000-8000-000000000404')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('x-request-id', traceId)
        .expect(404);

      expect(res.headers['x-request-id']).toBe(traceId);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toContain('not found');
      expect(res.body.requestId).toBe(traceId);
      expect(res.body.timestamp).toBeDefined();
    });

    it('generates a fresh UUID when x-request-id is omitted by caller', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/orders/018f0000-0000-7000-8000-000000000404')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });
  });

  describe('Cache-Control & Headers Hardening', () => {
    it('sets Cache-Control: no-store on mutating endpoints', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({ code: 'SAVE10', cartTotal: 50.0 })
        .expect(200);

      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('Internal ServiceKeyGuard Security', () => {
    it('rejects internal requests missing x-service-key header with 401', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/internal/orders/${sampleOrderId}`)
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.body.error.message).toContain('Missing x-service-key header');
    });

    it('rejects internal requests with invalid x-service-key header with 401', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/internal/orders/${sampleOrderId}`)
        .set('x-service-key', 'forged-attacker-key')
        .expect(401);

      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      expect(res.body.error.message).toContain('Invalid service key');
    });

    it('allows internal requests with valid x-service-key header', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/internal/orders/${sampleOrderId}`)
        .set('x-service-key', serviceKey)
        .expect(200);

      expect(res.body.order).toBeDefined();
      expect(res.body.order.id).toBe(sampleOrderId);
    });
  });

  describe('Cross-Customer & RBAC Isolation', () => {
    it('prevents customer from accessing another customer order (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .get(`/api/v1/orders/${sampleOrderId}`)
        .set('Authorization', `Bearer ${otherCustomerToken}`)
        .expect(403);
    });

    it('prevents non-admin customer from updating order status (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .patch(`/api/v1/orders/${sampleOrderId}/status`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ status: 'delivered' })
        .expect(403);
    });

    it('prevents non-admin customer from issuing refunds (403 Forbidden)', async () => {
      await request(app.getHttpServer())
        .post(`/api/v1/orders/${sampleOrderId}/refund`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ amount: 10 })
        .expect(403);
    });
  });

  describe('Prototype Pollution & Parameter Tampering', () => {
    it('rejects unknown or polluted fields via ValidationPipe forbidNonWhitelisted', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({
          code: 'SAVE10',
          cartTotal: 50.0,
          isAdmin: true,
          __proto__: { polluted: true },
        })
        .expect(400);

      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toBeDefined();
    });
  });

  describe('SQL Injection Immunity', () => {
    it('safely handles malicious SQL injections in coupon validation', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/discount-codes/validate')
        .send({
          code: "SAVE10' OR '1'='1",
          cartTotal: 50.0,
        })
        .expect(200);

      expect(res.body.valid).toBe(false);
      expect(res.body.discount).toBeUndefined();
    });

    it('safely handles malicious SQL injections in order ID parameter', async () => {
      const res = await request(app.getHttpServer())
        .get("/api/v1/orders/018f0000-0000-7000-8000-000000000001' OR 1=1--")
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);

      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});
