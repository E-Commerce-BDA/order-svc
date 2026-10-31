import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Kafka } from 'kafkajs';
import type { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { KafkaEventPublisher, OutboxRelay } from '@ecom/messaging';
import { OUTBOX_PUBLISHER, OUTBOX_RELAY } from '@ecom/messaging/nest';
import {
  JWT_ALGORITHM,
  JWT_AUDIENCE,
  JWT_ISSUER,
} from './../src/auth/auth.constants.js';
import { AppModule } from './../src/app.module.js';
import {
  CatalogClient,
  type ProductSnapshot,
} from './../src/clients/catalog.client.js';
import { closePool, getPool } from './../src/db/pool.js';
import { RedisService } from './../src/redis/redis.service.js';

if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile();
}
process.env.DATABASE_URL ??= 'postgresql://ecom:ecom-dev-only@localhost:5433/ecom';

const RUN_ID = randomUUID().slice(0, 8);
const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

/**
 * The one gate that needs a broker. Everything else drives `drainOnce()`
 * against a recording publisher.
 *
 * `RUN_KAFKA_E2E=1 pnpm test:e2e -- test/live-kafka.e2e-spec.ts`
 */
const describeLive = process.env.RUN_KAFKA_E2E === '1' ? describe : describe.skip;

describeLive('Live Kafka delivery (e2e)', () => {
  let app: INestApplication<App>;
  let pool: Pool;
  let moduleRelay: OutboxRelay;
  let publisher: KafkaEventPublisher;
  let kafka: Kafka;
  let customerToken: string;
  let adminToken: string;

  const customerId = '018f0000-0000-7000-8000-000000000001';
  const adminId = '018f0000-0000-7000-8000-000000000099';
  const productId = '018f0000-0000-7000-8000-000000000101';
  const orderIds: string[] = [];

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

  /** Drains until this order's `order.created` row is published. */
  async function drainUntilPublished(
    aggregateId: string,
    eventType: 'order.created' | 'order.status.updated',
  ): Promise<string> {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const { rows } = await pool.query<{ event_id: string; status: string }>(
        `SELECT event_id, status FROM "order".outbox
          WHERE aggregate_id = $1 AND event_type = $2`,
        [aggregateId, eventType],
      );

      const published = rows.find((row) => row.status === 'published');
      if (published) {
        return published.event_id;
      }

      await moduleRelay.drainOnce();
    }

    throw new Error(`no published ${eventType} row for ${aggregateId}`);
  }

  /** Checkout against the catalog fake; returns the confirmed order id. */
  async function checkout(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/checkout')
      .set('Authorization', `Bearer ${customerToken}`)
      .set('x-idempotency-key', `live-${RUN_ID}-${randomUUID()}`)
      .send(checkoutPayload())
      .expect(201);

    const orderId = (response.body as { orderId: string }).orderId;
    orderIds.push(orderId);
    return orderId;
  }

  /**
   * Reads the topic from the beginning and resolves when the message carrying
   * this event id arrives. A fresh consumer group per run, so `fromBeginning`
   * replays the topic instead of skipping to the current offset.
   */
  async function expectOnTopic(topic: string, eventId: string): Promise<void> {
    const consumer = kafka.consumer({ groupId: `order-live-${RUN_ID}-${topic}` });
    let timer: NodeJS.Timeout | undefined;

    await consumer.connect();
    await consumer.subscribe({ topics: [topic], fromBeginning: true });

    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no ${topic} message for event ${eventId}`)),
        20000,
      );

      void consumer.run({
        eachMessage: async ({ message }) => {
          if (message.headers?.['x-event-id']?.toString() === eventId) {
            resolve();
          }
        },
      });
    });

    try {
      await delivered;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      await consumer.disconnect();
    }
  }

  beforeAll(async () => {
    publisher = new KafkaEventPublisher({
      brokers: () => BROKERS,
      clientId: 'order-live-e2e',
    });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CatalogClient)
      .useValue(catalogFake)
      // The relay's `enabled` flag is read while the module is declared, so an
      // env flip inside this file would be too late; override the publisher.
      .overrideProvider(OUTBOX_PUBLISHER)
      .useValue(publisher)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('/api/v1', { exclude: ['health', 'health/ready'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    // `enableOfflineQueue: false` turns a command issued before the socket is up
    // into an error, so the first checkout would race the connect.
    const redis = app.get(RedisService);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await redis.ping()) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    customerToken = await app.get(JwtService).signAsync(
      { sub: customerId, email: 'customer@example.com', roles: ['customer'] },
      {
        secret: app.get(ConfigService).getOrThrow<string>('JWT_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );
    adminToken = await app.get(JwtService).signAsync(
      { sub: adminId, email: 'admin@example.com', roles: ['admin'] },
      {
        secret: app.get(ConfigService).getOrThrow<string>('JWT_SECRET'),
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        algorithm: JWT_ALGORITHM,
        expiresIn: '1h',
      },
    );

    pool = getPool();
    moduleRelay = app.get<OutboxRelay>(OUTBOX_RELAY);
    kafka = new Kafka({ clientId: `order-live-${RUN_ID}`, brokers: BROKERS });
  });

  afterAll(async () => {
    if (pool) {
      if (orderIds.length > 0) {
        await pool.query(
          `DELETE FROM "order".outbox WHERE aggregate_id = ANY($1::uuid[])`,
          [orderIds],
        );
        await pool.query(
          `DELETE FROM "order".orders WHERE id = ANY($1::uuid[])`,
          [orderIds],
        );
      }
    }

    await publisher?.close();

    if (app) {
      await app.close();
    }
    await closePool();
  });

  it('delivers order.created to its topic', async () => {
    const orderId = await checkout();

    const eventId = await drainUntilPublished(orderId, 'order.created');
    await expectOnTopic('order.created', eventId);
  }, 60000);

  it('delivers order.status.updated to its topic', async () => {
    const orderId = await checkout();

    await request(app.getHttpServer())
      .patch(`/api/v1/order/orders/${orderId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'processing' })
      .expect(200);

    const eventId = await drainUntilPublished(orderId, 'order.status.updated');
    await expectOnTopic('order.status.updated', eventId);
  }, 60000);
});
