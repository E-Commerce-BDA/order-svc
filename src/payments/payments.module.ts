import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';

@Module({
  providers: [PaymentsService]
})
export class PaymentsModule {}
