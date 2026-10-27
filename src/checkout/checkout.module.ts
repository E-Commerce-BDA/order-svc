import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { RedisModule } from '../redis/redis.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { DiscountsModule } from '../discounts/discounts.module.js';
import { CatalogClient } from '../clients/catalog.client.js';
import { CartClient } from '../clients/cart.client.js';

@Module({
  imports: [RedisModule, PaymentsModule, DiscountsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService, CatalogClient, CartClient],
  exports: [CheckoutService, CatalogClient, CartClient],
})
export class CheckoutModule {}
