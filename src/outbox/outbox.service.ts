import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OutboxRepository } from './outbox.repository.js';
import type { OutboxRow } from '../db/rows.js';

@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxService.name);
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(private readonly outboxRepository: OutboxRepository) {}

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_OUTBOX_RELAY === 'true'
    ) {
      return;
    }
    this.startRelay(2000);
  }

  onModuleDestroy(): void {
    this.stopRelay();
  }

  startRelay(intervalMs = 2000): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.processPendingEvents().catch((err: unknown) => {
        this.logger.error('Error in outbox relay cycle', err);
      });
    }, intervalMs);
  }

  stopRelay(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Polls and dispatches pending events from PostgreSQL to message bus / log.
   * Returns total events processed in this batch.
   */
  async processPendingEvents(batchSize = 20): Promise<number> {
    if (this.isProcessing) {
      return 0;
    }
    this.isProcessing = true;
    try {
      const events = await this.outboxRepository.fetchPendingEvents(batchSize);
      for (const event of events) {
        try {
          await this.dispatchEvent(event);
          await this.outboxRepository.markPublished(event.id);
        } catch (dispatchErr: unknown) {
          this.logger.error(`Failed to dispatch event ${event.id}`, dispatchErr);
          await this.outboxRepository.markFailed(event.id);
        }
      }
      return events.length;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Simulated broker dispatcher (Kafka / RabbitMQ / EventBridge).
   */
  async dispatchEvent(event: OutboxRow): Promise<void> {
    this.logger.log(
      `Dispatched outbox event [${event.event_type}] for aggregate ${event.aggregate_type}:${event.aggregate_id}`,
    );
  }
}
