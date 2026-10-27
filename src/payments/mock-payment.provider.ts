import { Injectable } from '@nestjs/common';
import { IPaymentProvider, PaymentResult } from './payment-provider.interface.js';
import { randomUUID } from 'node:crypto';

@Injectable()
export class MockPaymentProvider implements IPaymentProvider {
  async capture(
    amount: number,
    _orderId: string,
    _metadata?: Record<string, unknown>,
  ): Promise<PaymentResult> {
    if (amount < 0) {
      return {
        success: false,
        errorMessage: 'Invalid payment amount: amount cannot be negative',
      };
    }

    // Mock successful authorization & capture
    const transactionId = `mock_tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return {
      success: true,
      transactionId,
    };
  }

  async refund(
    transactionId: string,
    amount: number,
    _reason?: string,
  ): Promise<PaymentResult> {
    if (amount <= 0) {
      return {
        success: false,
        errorMessage: 'Refund amount must be greater than zero',
      };
    }

    return {
      success: true,
      transactionId: `mock_ref_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    };
  }
}
