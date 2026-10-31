import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomInt, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  eventEnvelopeSchema,
  parseEventEnvelope,
  type EventEnvelope,
} from '@ecom/contracts';
import { OutboxRelay, RecordingPublisher } from '@ecom/messaging';
import { OUTBOX_PUBLISHER, OUTBOX_RELAY } from '@ecom/messaging/nest';
import { vi } from 'vitest';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import { closePool, getPool } from './../src/db/pool.js';
import {
  CatalogClient,
  type ProductSnapshot,
} from './../src/clients/catalog.client.js';
import { CheckoutRepository } from './../src/checkout/checkout.repository.js';
import { RedisService } from './../src/redis/redis.service.js';
import { OrderOutbox } from './../src/outbox/order-outbox.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

const RUN_ID = randomUUID().slice(0, 8);

/**
 * A `order.outbox` row as this suite reads it.
 *
 * `payload` is null on every row written after migration 006: the envelope is
 * the only description of the event, which is exactly what the relay publishes.
 */
interface OrderOutboxRow {
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  envelope: EventEnvelope;
  status: string;
  attempts: number;
  last_error: string | null;
  locked_until: Date | null;
  created_at: Date;
  published_at: Date | null;
}

const OUTBOX_COLUMNS = `id, event_id, aggregate_type, aggregate_id, event_type,
       payload, envelope, status, attempts, last_error, locked_until,
       created_at, published_at`;

/** All rows written for these aggregates, in publish order. */
async function orderOutboxRows(
  pool: Pool,
  aggregateIds: string[],
): Promise<OrderOutboxRow[]> {
  if (aggregateIds.length === 0) {
    return [];
  }

  const { rows } = await pool.query<OrderOutboxRow>(
    `SELECT ${OUTBOX_COLUMNS}
       FROM "order".outbox
      WHERE aggregate_id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [aggregateIds],
  );

  return rows;
}

describe('Order outbox (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let moduleRelay: OutboxRelay;
  let publisher: RecordingPublisher;
  let checkoutRepository: CheckoutRepository;
  let orderOutbox: OrderOutbox;
  let customerToken: string;
  let adminToken: string;

  const customerId = '018f0000-0000-7000-8000-000000000001';
  const adminId = '018f0000-0000-7000-8000-000000000099';
  const productId = '018f0000-0000-7000-8000-000000000101';
  /** Every order this suite writes events for; teardown scopes to these. */
  const orderIds: string[] = [];

  function trackOrder(id: string): string {
    orderIds.push(id);
    return id;
  }

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

  /** Contract-faithful catalog fake: the checkout saga sends `quantity`. */
  const catalogFake = {
    reserveStock: vi.fn(async (reservationId: string, items: unknown[]) => ({
      ok: true,
      reservationId,
      status: 'held' as const,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      items,
    })),
    releaseStock: vi.fn(async () => ({ ok: true, status: 'released' })),
    getProductSnapshots: vi.fn(async (ids: string[]) => {
      const map = new Map<string, ProductSnapshot>();
      for (const id of ids) {
        if (id === productId) map.set(productId, productSnapshot);
      }
      return map;
    }),
  };

  /**
   * A cart with no discount code on purpose: the totals are then computed from
   * the snapshot alone, so the expected `order.created` payload does not depend
   * on a discount row another suite seeded.
   */
  const checkoutPayload = () => ({
    items: [{ productId, qty: 2 }],
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
    payment: { provider: 'mock' },
  });

  async function checkout(): Promise<{ orderId: string; orderNumber: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', `outbox-${RUN_ID}-${randomUUID()}`)
      .send(checkoutPayload())
      .expect(201);

    const order = response.body as { orderId: string; orderNumber: string };
    trackOrder(order.orderId);
    return order;
  }

  /**
   * A `pending` order with an unpaid payment, so the confirmation transaction
   * can be driven directly and forced to fail at a chosen point.
   */
  async function seedPendingOrder(): Promise<string> {
    const orderId = trackOrder(randomUUID());
    const orderNumber = `#2026-${randomInt(100_000, 999_999)}`;

    await pool.query(
      `INSERT INTO "order".orders (
        id, user_id, order_number, status, subtotal, shipping_fee, tax, discount,
        grand_total, currency, payment_status, shipping_address, billing_address
      ) VALUES (
        $1, $2, $3, 'pending', '160.00', '0.00', '0.00', '0.00',
        '160.00', 'USD', 'pending', '{"line1":"456 Market St"}', '{"line1":"456 Market St"}'
      );`,
      [orderId, customerId, orderNumber],
    );

    await pool.query(
      `INSERT INTO "order".payments (order_id, provider, amount, status)
       VALUES ($1, 'mock', '160.00', 'pending');`,
      [orderId],
    );

    return orderId;
  }

  /**
   * Drain the real module relay until this aggregate's rows are published.
   *
   * The `order.outbox` queue is shared with the other e2e suites (which never
   * start a relay), so one drain may spend its whole batch on their older rows.
   * The wait therefore counts *this* order only, and each cycle retries.
   */
  async function drainUntilPublished(
    aggregateId: string,
    expected: number,
  ): Promise<void> {
    let last = '';

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const rows = await orderOutboxRows(pool, [aggregateId]);
      if (rows.filter((row) => row.status === 'published').length >= expected) {
        return;
      }

      const result = await moduleRelay.drainOnce();
      last = JSON.stringify(result);
    }

    throw new Error(
      `relay did not publish ${expected} row(s) for ${aggregateId}; last drain ${last}`,
    );
  }

  beforeAll(async () => {
    publisher = new RecordingPublisher();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CatalogClient)
      .useValue(catalogFake)
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
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

    // A second ioredis client is created for this app; `enableOfflineQueue:
    // false` turns a command issued before the socket is up into an error, so
    // the first checkout would race the connect.
    const redis = app.get(RedisService);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await redis.ping()) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const jwtService = app.get(JwtService);
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

    pool = getPool();
    moduleRelay = app.get<OutboxRelay>(OUTBOX_RELAY);
    checkoutRepository = app.get(CheckoutRepository);
    orderOutbox = app.get(OrderOutbox);
  });

  afterAll(async () => {
    if (pool) {
      if (orderIds.length > 0) {
        await pool.query(
          `DELETE FROM "order".outbox WHERE aggregate_id = ANY($1::uuid[])`,
          [orderIds],
        );
        // Items, history, payments, shipments and refunds cascade.
        await pool.query(
          `DELETE FROM "order".orders WHERE id = ANY($1::uuid[])`,
          [orderIds],
        );
      }
    }

    if (app) {
      await app.close();
    }
    await closePool();
  });

  beforeEach(() => {
    publisher.reset();
  });

  it('writes exactly one valid order.created row when checkout confirms', async () => {
    const order = await checkout();

    const rows = await orderOutboxRows(pool, [order.orderId]);
    expect(rows).toHaveLength(1);

    const [row] = rows;
    expect(row).toMatchObject({
      aggregate_type: 'order',
      aggregate_id: order.orderId,
      event_type: 'order.created',
      status: 'pending',
      attempts: 0,
      last_error: null,
      locked_until: null,
      published_at: null,
      // 006 leaves `payload` behind as audit data for pre-envelope rows only.
      payload: null,
    });

    expect(eventEnvelopeSchema.safeParse(row!.envelope).success).toBe(true);
    expect(row!.envelope).toMatchObject({
      id: row!.event_id,
      type: 'order.created',
      topic: 'order.created',
      eventType: 'order.created',
      version: 1,
      producer: 'order-svc',
      idempotencyKey: row!.event_id,
    });

    const payload = parseEventEnvelope('order.created', row!.envelope);
    expect(payload.orderId).toBe(order.orderId);
    expect(payload.orderNumber).toBe(order.orderNumber);
    expect(payload.userId).toBe(customerId);
    // 80.00 * 2, free shipping above 100, no discount code.
    expect(payload.grandTotal).toBe(160);
    expect(payload.itemsCount).toBe(1);
    expect(payload.reservationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(row!.envelope.timestamp).toBe(payload.createdAt);
  });

  it('writes order.status.updated for an admin transition', async () => {
    const order = await checkout();

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${order.orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'processing', note: 'Picked in warehouse' })
      .expect(200);

    const rows = await orderOutboxRows(pool, [order.orderId]);
    expect(rows).toHaveLength(2);

    const statusRow = rows[1]!;
    expect(statusRow).toMatchObject({
      aggregate_type: 'order',
      aggregate_id: order.orderId,
      event_type: 'order.status.updated',
      status: 'pending',
      payload: null,
    });
    expect(eventEnvelopeSchema.safeParse(statusRow.envelope).success).toBe(true);

    const payload = parseEventEnvelope('order.status.updated', statusRow.envelope);
    expect(payload).toMatchObject({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      from: 'confirmed',
      to: 'processing',
      note: 'Picked in warehouse',
      actor: adminId,
    });
    expect(statusRow.envelope.timestamp).toBe(payload.timestamp);
  });

  it('publishes keyed by order id, in order, and marks the rows published', async () => {
    const order = await checkout();

    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${order.orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'processing' })
      .expect(200);

    const pending = await orderOutboxRows(pool, [order.orderId]);
    expect(pending).toHaveLength(2);

    await drainUntilPublished(order.orderId, 2);

    const rows = await orderOutboxRows(pool, [order.orderId]);
    for (const row of rows) {
      expect(row.status).toBe('published');
      expect(row.published_at).toBeInstanceOf(Date);
      expect(row.locked_until).toBeNull();
    }

    const published = publisher.published.filter(
      (entry) => entry.key === order.orderId,
    );
    expect(published).toHaveLength(2);
    // Sequential publish in claim order is what keeps per-order order honest.
    expect(published[0]!.topic).toBe('order.created');
    expect(published[1]!.topic).toBe('order.status.updated');
    expect(published[0]!.envelope.id).toBe(rows[0]!.event_id);
    expect(published[1]!.envelope.id).toBe(rows[1]!.event_id);
    expect(published[0]!.envelope).toEqual(rows[0]!.envelope);
  });

  it('writes nothing when the transition is rejected', async () => {
    const order = await checkout();
    const before = await orderOutboxRows(pool, [order.orderId]);

    // confirmed → delivered is not a legal edge in the state machine.
    await request(app.getHttpServer())
      .patch(`/api/v1/orders/${order.orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'delivered' })
      .expect(400);

    expect(await orderOutboxRows(pool, [order.orderId])).toHaveLength(
      before.length,
    );
  });

  it('rolls the event back with the confirmation when the transaction fails', async () => {
    const orderId = await seedPendingOrder();

    await expect(
      checkoutRepository.confirmOrder(
        orderId,
        { transactionId: `tx_outbox_${RUN_ID}` },
        {
          topic: 'order.created',
          payload: () => {
            // Stands in for any failure between the event write and the commit.
            throw new Error('forced failure after the outbox write');
          },
        },
      ),
    ).rejects.toThrow('forced failure after the outbox write');

    const order = await pool.query<{ status: string; payment_status: string }>(
      `SELECT status, payment_status FROM "order".orders WHERE id = $1;`,
      [orderId],
    );
    expect(order.rows[0]).toMatchObject({
      status: 'pending',
      payment_status: 'pending',
    });

    const payment = await pool.query<{ status: string }>(
      `SELECT status FROM "order".payments WHERE order_id = $1;`,
      [orderId],
    );
    expect(payment.rows[0]!.status).toBe('pending');

    const history = await pool.query<{ id: string }>(
      `SELECT id FROM "order".order_status_history WHERE order_id = $1;`,
      [orderId],
    );
    expect(history.rows).toHaveLength(0);

    expect(await orderOutboxRows(pool, [orderId])).toHaveLength(0);
  });

  it('writes the row through the caller transaction, so a rollback discards it', async () => {
    const orderId = trackOrder(randomUUID());
    const orderNumber = `#2026-${randomInt(100_000, 999_999)}`;
    const client = await pool.connect();
    let eventId = '';

    try {
      await client.query('BEGIN');

      eventId = await orderOutbox.recordOrderCreated(
        client,
        {
          topic: 'order.created',
          payload: ({ orderId: id, orderNumber: number }) => ({
            orderId: id,
            orderNumber: number,
            userId: customerId,
            grandTotal: 160,
            itemsCount: 1,
            reservationId: randomUUID(),
            createdAt: new Date().toISOString(),
          }),
        },
        { orderId, orderNumber },
      );

      // Visible inside the transaction: the store used the client it was given.
      const inside = await client.query<{ count: string }>(
        `SELECT count(*) FROM "order".outbox WHERE event_id = $1;`,
        [eventId],
      );
      expect(Number(inside.rows[0]!.count)).toBe(1);

      throw new Error('forced rollback');
    } catch (error) {
      await client.query('ROLLBACK');
      expect((error as Error).message).toBe('forced rollback');
    } finally {
      client.release();
    }

    expect(eventId).not.toBe('');
    expect(await orderOutboxRows(pool, [orderId])).toHaveLength(0);
  });
});
