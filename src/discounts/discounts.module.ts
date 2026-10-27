import { Module } from '@nestjs/common';
import { DiscountsController } from './discounts.controller.js';
import { DiscountsService } from './discounts.service.js';

@Module({
  controllers: [DiscountsController],
  providers: [DiscountsService]
})
export class DiscountsModule {}
