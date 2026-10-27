import { Module } from '@nestjs/common';
import {
  CustomerOrdersController,
  OrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { OrdersRepository } from './orders.repository.js';

@Module({
  controllers: [CustomerOrdersController, OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
