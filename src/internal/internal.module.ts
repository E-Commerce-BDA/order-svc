import { Module } from '@nestjs/common';
import { InternalController } from './internal.controller.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ServiceKeyGuard } from '../common/guards/service-key.guard.js';

@Module({
  imports: [OrdersModule],
  controllers: [InternalController],
  providers: [ServiceKeyGuard],
})
export class InternalModule {}
