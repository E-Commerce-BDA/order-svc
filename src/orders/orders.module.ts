import { Module } from '@nestjs/common';
import {
  CustomerOrdersController,
  OrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';
import { RefundsRepository } from './refunds.repository.js';
import { ClientsModule } from '../clients/clients.module.js';
import { PaymentsModule } from '../payments/payments.module.js';

@Module({
  imports: [ClientsModule, PaymentsModule],
  controllers: [CustomerOrdersController, OrdersController],
  providers: [OrdersService, OrdersRepository, RefundsRepository],
  exports: [OrdersService, OrdersRepository, RefundsRepository],
})
export class OrdersModule {}
