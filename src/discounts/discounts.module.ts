import { Module } from '@nestjs/common';
import { DiscountsController } from './discounts.controller.js';
import { DiscountsService } from './discounts.service.js';
import { DiscountsRepository } from './discounts.repository.js';

@Module({
  controllers: [DiscountsController],
  providers: [DiscountsService, DiscountsRepository],
  exports: [DiscountsService, DiscountsRepository],
})
export class DiscountsModule {}
