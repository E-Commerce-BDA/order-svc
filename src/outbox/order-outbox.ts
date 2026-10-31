import { Inject, Injectable } from '@nestjs/common';
import type {
  OrderCreatedPayload,
  OrderStatusUpdatedPayload,
} from '@ecom/contracts';
import type {
  EventTopic,
  OutboxStorePort,
  OutboxWriteInput,
  Queryable,
} from '@ecom/messaging';
import { OUTBOX_STORE } from '@ecom/messaging/nest';
import { v7 as uuidv7 } from 'uuid';

/** The two topics order-svc owns. Anything else is a bug, not a caller choice. */
export type OrderTopic = 'order.created' | 'order.status.updated';

export interface OrderIdentity {
  orderId: string;
  orderNumber: string;
}

/**
 * The `order.created` write the checkout saga hands to the repository.
 *
 * The payload cannot be built before the insert — the order number does not
 * exist until `INSERT ... RETURNING` — so the repository takes a builder and
 * resolves it inside the transaction.
 */
export interface OrderCreatedWrite {
  topic: 'order.created';
  payload: (order: OrderIdentity) => OrderCreatedPayload;
}

/**
 * Writes order events into `order.outbox`, inside the caller's transaction.
 *
 * Payload assembly lives here so `store.write` validates it against the
 * contracts schema before the row is inserted: a drifted payload aborts the
 * mutation instead of leaving an event no consumer can parse. The timestamp of
 * the event is taken from the payload (`createdAt` / `timestamp`) so a replay
 * reproduces the original envelope rather than the moment the relay ran.
 */
@Injectable()
export class OrderOutbox {
  constructor(@Inject(OUTBOX_STORE) private readonly store: OutboxStorePort) {}

  async recordOrderCreated(
    client: Queryable,
    write: OrderCreatedWrite,
    order: OrderIdentity,
  ): Promise<string> {
    return this.writeCreated(client, write.payload(order));
  }

  async recordStatusUpdated(
    client: Queryable,
    payload: OrderStatusUpdatedPayload,
  ): Promise<string> {
    return this.writeStatusUpdated(client, payload);
  }

  private writeCreated(
    client: Queryable,
    payload: OrderCreatedPayload,
  ): Promise<string> {
    return this.write(client, {
      topic: 'order.created',
      eventId: uuidv7(),
      aggregateType: 'order',
      aggregateId: payload.orderId,
      occurredAt: new Date(payload.createdAt),
      payload,
    });
  }

  private writeStatusUpdated(
    client: Queryable,
    payload: OrderStatusUpdatedPayload,
  ): Promise<string> {
    return this.write(client, {
      topic: 'order.status.updated',
      eventId: uuidv7(),
      aggregateType: 'order',
      aggregateId: payload.orderId,
      occurredAt: new Date(payload.timestamp),
      payload,
    });
  }

  private write<T extends EventTopic>(
    client: Queryable,
    input: OutboxWriteInput<T>,
  ): Promise<string> {
    return this.store.write(client, input);
  }
}
