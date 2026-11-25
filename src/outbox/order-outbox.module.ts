import { Global, Module } from '@nestjs/common';
import { createOutboxModule } from '@ecom/messaging/nest/outbox';
import { getPool } from '../db/pool.js';
import { OrderOutbox } from './order-outbox.js';

/**
 * Owns `order.outbox` and drains it.
 *
 * Global because the three write sites live in two feature modules
 * (`CheckoutModule`, `OrdersModule`) and each one must inject the same
 * `OrderOutbox`; importing the outbox module three times would register three
 * relays against one table.
 *
 * `schema: 'order'` only works because `@ecom/messaging` quotes its identifiers —
 * `order` is a reserved word, so an unquoted `${schema}.${table}` was a syntax
 * error. The `/nest/outbox` entry keeps the optional SQS peer off this service's
 * boot path.
 */
@Global()
@Module({
  imports: [
    createOutboxModule({
      schema: 'order',
      producer: 'order-svc',
      clientId: 'order-svc',
      pool: getPool,
    }),
  ],
  providers: [OrderOutbox],
  exports: [OrderOutbox],
})
export class OrderOutboxModule {}
