import { Global, Module } from '@nestjs/common';
import { createOutboxModule } from '@ecom/messaging/nest';
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
 * `schema: 'order'` only works because `@ecom/messaging` 0.2.0 quotes its
 * identifiers — `order` is a reserved word, so the pre-0.2.0 unquoted
 * `${schema}.${table}` was a syntax error.
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
