import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule, type TestingModuleBuilder } from '@nestjs/testing';
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
import { CheckoutRepository } from './../src/checkout/checkout.repository.js';
import { PaymentsService } from './../src/payments/payments.service.js';
import { RedisService } from './../src/redis/redis.service.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  OrderRow,
  OrderItemRow,
  OrderStatusHistoryRow,
  OutboxRow,
  PaymentRow,
} from '../src/db/rows.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

/**
 * ord-011: the row now carries the canonical envelope and leaves `payload`
 * null, so the event is read from the envelope it will be published with.
 */
function orderCreatedPayloadOf(row: OutboxRow): {
  orderId: string;
  orderNumber: string;
  reservationId: string;
} {
  const envelope = row.envelope as {
    type?: string;
    payload?: { orderId: string; orderNumber: string; reservationId: string };
  } | null;

  expect(envelope?.type).toBe('order.created');
  return envelope!.payload!;
}

describe('Checkout (e2e)', () => {
  let app: INestApplication<App>;
  let jwtService: JwtService;
  let customerToken: string;
  let otherCustomerToken: string;
  let mockCatalogClient: {
    reserveStock: ReturnType<typeof vi.fn>;
    releaseStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };

  const userId = '018f0000-0000-7000-8000-000000000001';
  const otherUserId = '018f0000-0000-7000-8000-000000000002';
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

  /**
   * A second app for the cases that need a different provider or a broken
   * collaborator. Each one owns its own catalog fake so call counts stay local.
   */
  const launchApp = async (
    catalog: ReturnType<typeof createCatalogFake>,
    customize?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
  ): Promise<INestApplication<App>> => {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CatalogClient)
      .useValue(catalog);

    if (customize) builder = customize(builder);

    const moduleFixture: TestingModule = await builder.compile();
    const instance = moduleFixture.createNestApplication();
    instance.setGlobalPrefix('/api/v1', {
      exclude: ['health', 'health/ready'],
    });
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await instance.init();

    // A second app in the same process gets its own ioredis client, and
    // `enableOfflineQueue: false` makes any command issued before the socket is
    // up fail with "stream isn't writeable". Wait for it, or the first request
    // of the suite races the connect.
    const redis = instance.get(RedisService);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await redis.ping()) return instance;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    throw new Error('The second app could not reach Redis');
  };

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
    otherCustomerToken = await jwtService.signAsync(
      {
        sub: otherUserId,
        email: 'other@example.com',
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
    expect(outboxRows[0].payload).toBeNull();
    expect(orderCreatedPayloadOf(outboxRows[0]).reservationId).toBe(reservationId);

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

    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
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

    expect(conflictRes.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('isolates the same key between two customers', async () => {
    // The regression that motivated ord-008: a global idem:{key} served one
    // customer's confirmation to another.
    const key = `idem-shared-${randomUUID()}`;
    const payload = sampleCheckoutPayload();

    const first = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${otherCustomerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    expect(second.body.orderId).not.toBe(first.body.orderId);

    const { rows } = await getPool().query<{ user_id: string }>(
      `SELECT user_id FROM "order".orders WHERE idempotency_key = $1 ORDER BY user_id;`,
      [key],
    );
    expect(rows.map((row) => row.user_id)).toEqual([userId, otherUserId]);
  });

  it('replays from the order row after the cache entry is gone', async () => {
    const key = `idem-db-replay-${randomUUID()}`;
    const payload = sampleCheckoutPayload();

    const first = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    await app.get(RedisService).del(`idem:${userId}:checkout:${key}`);

    const replay = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(payload)
      .expect(201);

    expect(replay.body.orderId).toBe(first.body.orderId);
    expect(replay.body.orderNumber).toBe(first.body.orderNumber);

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM "order".orders WHERE user_id = $1 AND idempotency_key = $2;`,
      [userId, key],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('detects a reused key with a different body from the stored hash, not the cache', async () => {
    const key = `idem-db-conflict-${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(sampleCheckoutPayload())
      .expect(201);

    // Drop the cache so only the persisted body hash can answer.
    await app.get(RedisService).del(`idem:${userId}:checkout:${key}`);

    const changed = sampleCheckoutPayload();
    changed.items[0].qty = 3;

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', key)
      .send(changed)
      .expect(409);

    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('writes exactly one order when the same request is submitted twice at once', async () => {
    const key = `idem-concurrent-${randomUUID()}`;
    const payload = sampleCheckoutPayload();

    const send = () =>
      request(app.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-idempotency-key', key)
        .send(payload);

    const responses = await Promise.all([send(), send()]);
    const statuses = responses.map((response) => response.status);

    // Whichever loses the race is either refused while the winner holds the
    // lock (409) or replayed from the row (201) — never a second order.
    for (const status of statuses) {
      expect([201, 409]).toContain(status);
    }
    const created = responses.filter((response) => response.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    if (created.length === 2) {
      expect(created[0].body.orderId).toBe(created[1].body.orderId);
    }

    const { rows } = await getPool().query<{ count: string }>(
      `SELECT count(*) FROM "order".orders WHERE user_id = $1 AND idempotency_key = $2;`,
      [userId, key],
    );
    expect(Number(rows[0].count)).toBe(1);
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

  /**
   * ord-009: money may only move once the order row exists, and every failure
   * after the first durable write has to leave something consistent behind.
   */
  describe('payment saga', () => {
    let sagaApp: INestApplication<App>;
    let sagaCatalog: ReturnType<typeof createCatalogFake>;

    interface CaptureAttempt {
      orderId: string;
      transactionId: string;
      status: string | undefined;
      paymentStatus: string | undefined;
    }

    const settle = {
      captures: [] as CaptureAttempt[],
      refunds: [] as Array<{ transactionId: string; amount: number; reason?: string }>,
      decline: false,
      throwOnce: false,
    };

    const paymentsFake = {
      processPayment: async (
        _provider: string,
        _amount: number,
        orderId: string,
      ): Promise<{ success: boolean; transactionId?: string; errorMessage?: string }> => {
        // Read the row *at capture time*: this is the structural proof that no
        // payment is authorised before the order exists, and that a resumed
        // attempt still finds it pending.
        const { rows } = await getPool().query<{ status: string; payment_status: string }>(
          `SELECT status, payment_status FROM "order".orders WHERE id = $1;`,
          [orderId],
        );
        const transactionId = `mock_tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        settle.captures.push({
          orderId,
          transactionId,
          status: rows[0]?.status,
          paymentStatus: rows[0]?.payment_status,
        });

        if (settle.throwOnce) {
          settle.throwOnce = false;
          throw new Error('socket hang up');
        }

        if (settle.decline) return { success: false, errorMessage: 'Declined by issuer' };

        return { success: true, transactionId };
      },
      processRefund: async (transactionId: string, amount: number, reason?: string) => {
        settle.refunds.push({ transactionId, amount, reason });
        return {
          success: true,
          transactionId: `mock_ref_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        };
      },
    };

    beforeAll(async () => {
      sagaCatalog = createCatalogFake();
      sagaApp = await launchApp(sagaCatalog, (builder) =>
        builder.overrideProvider(PaymentsService).useValue(paymentsFake),
      );
    });

    afterAll(async () => {
      await sagaApp.close();
    });

    beforeEach(() => {
      vi.restoreAllMocks();
      settle.captures.length = 0;
      settle.refunds.length = 0;
      settle.decline = false;
      settle.throwOnce = false;
      sagaCatalog.reserveStock.mockClear();
      sagaCatalog.releaseStock.mockClear();
    });

    const checkoutWith = (key: string, body: object = sampleCheckoutPayload()) =>
      request(sagaApp.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-idempotency-key', key)
        .send(body);

    const orderByKey = async (key: string): Promise<OrderRow[]> => {
      const { rows } = await getPool().query<OrderRow>(
        `SELECT * FROM "order".orders WHERE user_id = $1 AND idempotency_key = $2;`,
        [userId, key],
      );
      return rows;
    };

    it('captures only after the order row exists as pending', async () => {
      const key = `idem-saga-${randomUUID()}`;
      const res = await checkoutWith(key).expect(201);

      expect(res.body.status).toBe('confirmed');
      expect(settle.captures).toHaveLength(1);
      expect(settle.captures[0].orderId).toBe(res.body.orderId);
      expect(settle.captures[0].status).toBe('pending');
      expect(settle.captures[0].paymentStatus).toBe('pending');

      const payments = await getPool().query<PaymentRow>(
        `SELECT * FROM "order".payments WHERE order_id = $1;`,
        [res.body.orderId],
      );
      expect(payments.rows).toHaveLength(1);
      expect(payments.rows[0].status).toBe('captured');
      expect(payments.rows[0].transaction_id).toBe(settle.captures[0].transactionId);

      const history = await getPool().query<OrderStatusHistoryRow>(
        `SELECT * FROM "order".order_status_history WHERE order_id = $1 ORDER BY created_at;`,
        [res.body.orderId],
      );
      expect(history.rows.map((row) => [row.from_status, row.to_status])).toEqual([
        [null, 'pending'],
        ['pending', 'confirmed'],
      ]);

      const outbox = await getPool().query<OutboxRow>(
        `SELECT * FROM "order".outbox WHERE aggregate_id = $1;`,
        [res.body.orderId],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].event_type).toBe('order.created');
    });

    it('fails the attempt, releases the hold and burns the key when the card is declined', async () => {
      settle.decline = true;
      const key = `idem-declined-${randomUUID()}`;
      const res = await checkoutWith(key).expect(402);

      expect(res.body.code).toBe('PAYMENT_FAILED');

      const [order] = await orderByKey(key);
      expect(order.status).toBe('failed');
      expect(order.payment_status).toBe('failed');

      const payments = await getPool().query<PaymentRow>(
        `SELECT * FROM "order".payments WHERE order_id = $1;`,
        [order.id],
      );
      expect(payments.rows[0].status).toBe('failed');

      const history = await getPool().query<OrderStatusHistoryRow>(
        `SELECT * FROM "order".order_status_history WHERE order_id = $1 ORDER BY created_at;`,
        [order.id],
      );
      expect(history.rows.map((row) => row.to_status)).toEqual(['pending', 'failed']);

      const outbox = await getPool().query<OutboxRow>(
        `SELECT * FROM "order".outbox WHERE aggregate_id = $1;`,
        [order.id],
      );
      expect(outbox.rows).toHaveLength(0);

      expect(sagaCatalog.releaseStock).toHaveBeenCalledTimes(1);
      expect(sagaCatalog.releaseStock).toHaveBeenCalledWith(order.stock_reservation_id);

      const retry = await checkoutWith(key).expect(409);
      expect(retry.body.code).toBe('ORDER_ATTEMPT_CLOSED');
      expect(settle.captures).toHaveLength(1);
    });

    it('refunds the capture and closes the order when the confirmation cannot be persisted', async () => {
      const key = `idem-persist-fail-${randomUUID()}`;
      const repository = sagaApp.get(CheckoutRepository);
      vi.spyOn(repository, 'confirmOrder').mockRejectedValueOnce(new Error('deadlock detected'));

      const res = await checkoutWith(key).expect(503);
      expect(res.body.code).toBe('PAYMENT_PERSIST_FAILED');

      expect(settle.refunds).toHaveLength(1);
      expect(settle.refunds[0].transactionId).toBe(settle.captures[0].transactionId);
      expect(settle.refunds[0].amount).toBe(144);

      const [order] = await orderByKey(key);
      expect(order.status).toBe('failed');
      expect(order.payment_status).toBe('refunded');

      const payments = await getPool().query<PaymentRow>(
        `SELECT * FROM "order".payments WHERE order_id = $1;`,
        [order.id],
      );
      expect(payments.rows[0].status).toBe('refunded');

      const outbox = await getPool().query<OutboxRow>(
        `SELECT * FROM "order".outbox WHERE aggregate_id = $1;`,
        [order.id],
      );
      expect(outbox.rows).toHaveLength(0);
      expect(sagaCatalog.releaseStock).toHaveBeenCalledTimes(1);
    });

    it('resumes a pending attempt on the same order, hold and key', async () => {
      settle.throwOnce = true;
      const key = `idem-resume-${randomUUID()}`;
      const payload = sampleCheckoutPayload();

      const failedAttempt = await checkoutWith(key, payload).expect(503);
      expect(failedAttempt.body.code).toBe('PAYMENT_UNAVAILABLE');

      const [pending] = await orderByKey(key);
      expect(pending.status).toBe('pending');
      // The hold must survive the transient failure, otherwise the resume would
      // confirm stock that has already been given back.
      expect(sagaCatalog.releaseStock).not.toHaveBeenCalled();

      const resumed = await checkoutWith(key, payload).expect(201);
      expect(resumed.body.orderId).toBe(pending.id);
      expect(resumed.body.orderNumber).toBe(pending.order_number);
      expect(resumed.body.status).toBe('confirmed');

      // Two capture attempts, both against the same still-pending row: one order,
      // one reservation, one confirmation.
      expect(settle.captures).toHaveLength(2);
      expect(settle.captures[1].orderId).toBe(pending.id);
      expect(settle.captures[1].status).toBe('pending');
      expect(sagaCatalog.reserveStock).toHaveBeenCalledTimes(1);
      expect(await orderByKey(key)).toHaveLength(1);

      const outbox = await getPool().query<OutboxRow>(
        `SELECT * FROM "order".outbox WHERE aggregate_id = $1;`,
        [pending.id],
      );
      expect(outbox.rows).toHaveLength(1);
      expect(orderCreatedPayloadOf(outbox.rows[0]).reservationId).toBe(
        pending.stock_reservation_id,
      );
    });
  });

  /**
   * Redis is a hard dependency *before* the first durable write: without it we
   * cannot tell whether another attempt is already running, so checkout has to
   * refuse rather than risk a second order. Nothing may be written.
   */
  describe('with an unreachable redis', () => {
    let brokenApp: INestApplication<App>;

    beforeAll(async () => {
      const unavailable = () => Promise.reject(new Error('ECONNREFUSED'));

      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(CatalogClient)
        .useValue(createCatalogFake())
        .overrideProvider(RedisService)
        .useValue({
          get: unavailable,
          set: unavailable,
          setnx: unavailable,
          del: unavailable,
          ping: async () => false,
        })
        .compile();

      brokenApp = moduleFixture.createNestApplication();
      brokenApp.setGlobalPrefix('/api/v1', {
        exclude: ['health', 'health/ready'],
      });
      brokenApp.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
        }),
      );
      await brokenApp.init();
    });

    afterAll(async () => {
      await brokenApp.close();
    });

    it('fails closed with 503 IDEMPOTENCY_UNAVAILABLE and writes no order', async () => {
      const key = `idem-redis-down-${randomUUID()}`;

      const res = await request(brokenApp.getHttpServer())
        .post('/api/v1/checkout')
        .set('Authorization', `Bearer ${customerToken}`)
        .set('x-idempotency-key', key)
        .send(sampleCheckoutPayload())
        .expect(503);

      expect(res.body.code).toBe('IDEMPOTENCY_UNAVAILABLE');

      const { rows } = await getPool().query<{ count: string }>(
        `SELECT count(*) FROM "order".orders WHERE idempotency_key = $1;`,
        [key],
      );
      expect(Number(rows[0].count)).toBe(0);
    });
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
