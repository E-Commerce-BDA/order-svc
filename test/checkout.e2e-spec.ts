import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { closePool, getPool } from './../src/db/pool.js';
import {
  CatalogClient,
  type ProductSnapshot,
} from './../src/clients/catalog.client.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OrderRow, OrderItemRow, OutboxRow, PaymentRow } from '../src/db/rows.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

describe('Checkout (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let customerToken: string;
  let mockCatalogClient: {
    reserveStock: ReturnType<typeof vi.fn>;
    releaseStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };

  const userId = '018f0000-0000-7000-8000-000000000001';
  const productId = '018f0000-0000-7000-8000-000000000101';
  const variantId = '018f0000-0000-7000-8000-000000000201';
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const productSnapshot: ProductSnapshot = {
    productId,
    variantId: null,
    productName: 'Running Shoe Pro',
    sku: 'RSP-BLK-42',
    unitPrice: 80.0,
    effectivePrice: 80.0,
    available: true,
    stock: 25,
  };

  const variantSnapshot: ProductSnapshot = {
    productId,
    variantId,
    productName: 'Running Shoe Pro',
    sku: 'RSP-BLK-44',
    unitPrice: 95.0,
    effectivePrice: 95.0,
    available: true,
    stock: 7,
  };

  /**
   * Contract-faithful fake. It fails the suite if order-svc ever sends `qty`
   * again, drops the caller-supplied reservation id, or reads a snapshot under
   * the wrong key — a looser mock is what hid the 400-on-every-checkout bug.
   */
  const createCatalogFake = () => ({
    reserveStock: vi.fn(
      async (
        reservationId: string,
        items: Array<{
          productId: string;
          variantId?: string | null;
          quantity: number;
        }>,
      ) => {
        expect(reservationId).toMatch(UUID_RE);
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
          expect(item).toHaveProperty('quantity');
          expect(item).not.toHaveProperty('qty');
        }
        return {
          ok: true,
          reservationId,
          status: 'held' as const,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          items: items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
            remainingStock: 5,
          })),
        };
      },
    ),
    releaseStock: vi.fn(async (reservationId: string) => {
      expect(reservationId).toMatch(UUID_RE);
      return { ok: true, status: 'released' };
    }),
    getProductSnapshots: vi.fn(async (ids: string[]) => {
      const map = new Map<string, ProductSnapshot>();
      for (const id of ids) {
        if (id === variantId) map.set(variantId, variantSnapshot);
        else if (id === productId) map.set(productId, productSnapshot);
      }
      return map;
    }),
  });

  beforeAll(async () => {
    // Apply every migration in filename order so 003+ is picked up
    // automatically instead of being hardcoded here.
    const pool = getPool();
    const dbDir = join(__dirname, '../db');
    const migrations = readdirSync(dbDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const migration of migrations) {
      await pool.query(readFileSync(join(dbDir, migration), 'utf-8'));
    }

    mockCatalogClient = createCatalogFake();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CatalogClient)
      .useValue(mockCatalogClient)
      .compile();

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
      {
        sub: userId,
        email: 'customer@example.com',
        roles: ['customer'],
      },
      {
        secret,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  const sampleCheckoutPayload = () => ({
    items: [
      {
        productId,
        qty: 2,
      },
    ],
    shippingAddress: {
      line1: '456 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94103',
      country: 'US',
    },
    billingAddress: {
      line1: '456 Market St',
      city: 'San Francisco',
      state: 'CA',
      postalCode: '94103',
      country: 'US',
    },
    discountCode: 'SAVE10',
    payment: {
      provider: 'mock',
    },
    notes: 'Please leave at the front door',
  });

  it('rejects checkout request missing x-idempotency-key with 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .send(sampleCheckoutPayload())
      .expect(400);
  });

  it('rejects unauthenticated checkout with 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('x-idempotency-key', randomUUID())
      .send(sampleCheckoutPayload())
      .expect(401);
  });

  it('executes atomic checkout: reserves stock, captures mock payment, persists order and outbox', async () => {
    const key = `idem-test-${randomUUID()}`;
    const payload = sampleCheckoutPayload();

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    expect(res.body.orderId).toBeDefined();
    expect(res.body.orderNumber).toMatch(/^#2026-\d{6}$/);
    expect(res.body.status).toBe('confirmed');

    // Totals verification (subtotal: 80 * 2 = 160, shipping: 0 (subtotal >= 100), discount: 10% = 16, grandTotal: 144)
    expect(res.body.totals.subtotal).toBe(160);
    expect(res.body.totals.shipping).toBe(0);
    expect(res.body.totals.discount).toBe(16);
    expect(res.body.totals.grandTotal).toBe(144);

    const orderId = res.body.orderId;
    const pool = getPool();

    // Verify order row in PostgreSQL
    const { rows: orderRows } = await pool.query<OrderRow>(
      `SELECT * FROM "order".orders WHERE id = $1;`,
      [orderId],
    );
    expect(orderRows.length).toBe(1);
    expect(orderRows[0].user_id).toBe(userId);
    expect(parseFloat(orderRows[0].grand_total)).toBe(144);
    expect(orderRows[0].payment_status).toBe('paid');

    // Verify order items snapshot
    const { rows: itemRows } = await pool.query<OrderItemRow>(
      `SELECT * FROM "order".order_items WHERE order_id = $1;`,
      [orderId],
    );
    expect(itemRows.length).toBe(1);
    expect(itemRows[0].product_name).toBe('Running Shoe Pro');
    expect(itemRows[0].sku).toBe('RSP-BLK-42');
    expect(parseFloat(itemRows[0].unit_price)).toBe(80);
    expect(itemRows[0].qty).toBe(2);

    // Verify payment record
    const { rows: payRows } = await pool.query<PaymentRow>(
      `SELECT * FROM "order".payments WHERE order_id = $1;`,
      [orderId],
    );
    expect(payRows.length).toBe(1);
    expect(payRows[0].status).toBe('captured');

    // Verify transactional outbox row
    const { rows: outboxRows } = await pool.query<OutboxRow>(
      `SELECT * FROM "order".outbox WHERE aggregate_id = $1;`,
      [orderId],
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].event_type).toBe('order.created');
    expect(outboxRows[0].status).toBe('pending');

    // The hold that was taken for this checkout is persisted on the order, so a
    // later commit (cat-009) or cancellation can find it without guessing.
    const reservationId = mockCatalogClient.reserveStock.mock.calls[0][0] as string;
    expect(orderRows[0].stock_reservation_id).toBe(reservationId);
    expect(outboxRows[0].payload.reservationId).toBe(reservationId);

    // Snapshots are requested by `variantId ?? productId`.
    expect(mockCatalogClient.getProductSnapshots).toHaveBeenCalledWith([productId]);
  });

  it('prices a variant line from its own snapshot and stores the variant id', async () => {
    const key = `idem-variant-${randomUUID()}`;

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send({
        ...sampleCheckoutPayload(),
        items: [{ productId, variantId, qty: 1 }],
        discountCode: undefined,
      })
      .expect(201);

    // Variant price (95), no discount, shipping applies below the 100 threshold.
    expect(res.body.totals.subtotal).toBe(95);
    expect(res.body.totals.grandTotal).toBe(100);
    expect(mockCatalogClient.getProductSnapshots).toHaveBeenCalledWith([variantId]);

    const { rows } = await getPool().query<OrderItemRow>(
      `SELECT * FROM "order".order_items WHERE order_id = $1;`,
      [res.body.orderId],
    );
    expect(rows[0].variant_id).toBe(variantId);
    expect(rows[0].sku).toBe('RSP-BLK-44');
    expect(parseFloat(rows[0].unit_price)).toBe(95);
  });

  it('surfaces a catalog 409 as a checkout 409 with the stock failure code', async () => {
    mockCatalogClient.reserveStock.mockResolvedValueOnce({
      ok: false,
      failure: 'insufficient_stock',
      code: 'INSUFFICIENT_STOCK',
      message: 'Insufficient stock for product 018f0000-…',
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', `idem-stock-${randomUUID()}`)
      .send(sampleCheckoutPayload())
      .expect(409);

    expect(res.body.message).toContain('INSUFFICIENT_STOCK');
  });

  it('replays identical response instantly when resubmitting with same idempotency key', async () => {
    const key = `idem-replay-${randomUUID()}`;
    const payload = sampleCheckoutPayload();

    // 1st submission
    const firstRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    const pool = getPool();
    const countBefore = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "order".orders WHERE id = $1;`,
      [firstRes.body.orderId],
    );
    expect(parseInt(countBefore.rows[0].count, 10)).toBe(1);

    // 2nd submission with exact same key and payload
    const replayRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    expect(replayRes.body.orderId).toBe(firstRes.body.orderId);
    expect(replayRes.body.orderNumber).toBe(firstRes.body.orderNumber);

    // Assert no duplicate order created
    const countAfter = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "order".orders WHERE id = $1;`,
      [firstRes.body.orderId],
    );
    expect(parseInt(countAfter.rows[0].count, 10)).toBe(1);
  });

  it('rejects with 409 IDEMPOTENCY_CONFLICT when same idempotency key is reused with different payload', async () => {
    const key = `idem-conflict-${randomUUID()}`;
    const payload1 = sampleCheckoutPayload();

    await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload1)
      .expect(201);

    // Payload 2 modifies qty to 5
    const payload2 = sampleCheckoutPayload();
    payload2.items[0].qty = 5;

    const conflictRes = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload2)
      .expect(409);

    expect(conflictRes.body.message).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('rejects with 422 COUPON_INVALID and releases stock when coupon has expired', async () => {
    const key = `idem-coupon-${randomUUID()}`;
    const payload = sampleCheckoutPayload();
    payload.discountCode = 'EXPIRED50';

    const res = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(422);

    expect(res.body.message).toContain('expired');
    // Stock release compensation must have been invoked
    expect(mockCatalogClient.releaseStock).toHaveBeenCalled();
  });
});

const liveCatalogUrl = process.env.CATALOG_SVC_URL;
const liveProductId = process.env.CATALOG_TEST_PRODUCT_ID;

describe.skipIf(!liveCatalogUrl || !liveProductId)(
  'Checkout client against a live catalog-svc',
  () => {
    it('reads a real snapshot, including a real sku', async () => {
      const client = new CatalogClient({
        get: (key: string) =>
          key === 'CATALOG_SVC_URL'
            ? liveCatalogUrl
            : process.env.INTERNAL_SERVICE_KEY,
      } as unknown as ConfigService);

      const snapshots = await client.getProductSnapshots([liveProductId!]);
      const snapshot = snapshots.get(liveProductId!);

      expect(snapshot).toBeDefined();
      expect(snapshot!.sku).toBeTruthy();
      expect(snapshot!.available).toBe(true);
    });
  },
);
