import { Module } from '@nestjs/common';
import { ClientsModule } from '../clients/clients.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { RecoveryRepository } from './recovery.repository.js';
import { RecoveryScheduler } from './recovery.scheduler.js';
import { RecoveryService } from './recovery.service.js';

@Module({
  imports: [ClientsModule, OrdersModule, PaymentsModule],
  providers: [RecoveryRepository, RecoveryService, RecoveryScheduler],
  exports: [RecoveryService],
})
export class RecoveryModule {}
