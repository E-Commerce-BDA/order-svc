import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service.js';
import { MockPaymentProvider } from './mock-payment.provider.js';

@Module({
  providers: [PaymentsService, MockPaymentProvider],
  exports: [PaymentsService, MockPaymentProvider],
})
export class PaymentsModule {}
