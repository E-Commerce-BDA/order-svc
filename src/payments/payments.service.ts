import { Injectable } from '@nestjs/common';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PaymentResult } from './payment-provider.interface.js';

@Injectable()
export class PaymentsService {
  constructor(private readonly mockProvider: MockPaymentProvider) {}

  async processPayment(
    provider: 'mock' | 'stripe' | 'paypal',
    amount: number,
    orderId: string,
    metadata?: Record<string, unknown>,
  ): Promise<PaymentResult> {
    switch (provider) {
      case 'mock':
      case 'stripe':
      case 'paypal':
        // v1 routes all providers through mock engine
        return this.mockProvider.capture(amount, orderId, metadata);
      default:
        return {
          success: false,
          errorMessage: `Unsupported payment provider: ${String(provider)}`,
        };
    }
  }

  async processRefund(
    transactionId: string,
    amount: number,
    reason?: string,
  ): Promise<PaymentResult> {
    return this.mockProvider.refund(transactionId, amount, reason);
  }
}
