import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service.js';
import { OutboxRepository } from './outbox.repository.js';

@Module({
  providers: [OutboxService, OutboxRepository],
  exports: [OutboxService, OutboxRepository],
})
export class OutboxModule {}
