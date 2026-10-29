import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutRepository } from './checkout.repository.js';
import { RedisModule } from '../redis/redis.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { DiscountsModule } from '../discounts/discounts.module.js';
import { ClientsModule } from '../clients/clients.module.js';

@Module({
  imports: [RedisModule, PaymentsModule, DiscountsModule, ClientsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, CheckoutRepository],
  exports: [CheckoutService],
})
export class CheckoutModule {}
