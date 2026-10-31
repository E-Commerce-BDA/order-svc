import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './health/health.module.js';
import { DbModule } from './db/db.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DiscountsModule } from './discounts/discounts.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { OrdersModule } from './orders/orders.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { OrderOutboxModule } from './outbox/order-outbox.module.js';
import { InternalModule } from './internal/internal.module.js';
import Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: Joi.object({
        PORT: Joi.number().default(4040),
        DATABASE_URL: Joi.string().uri().required(),
        JWT_SECRET: Joi.string().min(32).required(),
        REDIS_URL: Joi.string().uri().default('redis://localhost:6379'),
        INTERNAL_SERVICE_KEY: Joi.string().required(),
        CATALOG_SVC_URL: Joi.string().uri().default('http://localhost:4020'),
        CART_SVC_URL: Joi.string().uri().default('http://localhost:4030'),
        KAFKA_BROKERS: Joi.string().default('localhost:9092'),
        DISABLE_OUTBOX_RELAY: Joi.boolean().default(false),
      }),
    }),
    HealthModule,
    DbModule,
    RedisModule,
    AuthModule,
    DiscountsModule,
    CheckoutModule,
    OrdersModule,
    PaymentsModule,
    OrderOutboxModule,
    InternalModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
