import { Injectable } from '@nestjs/common';
import { IPaymentProvider, PaymentResult } from './payment-provider.interface.js';
import { randomUUID } from 'node:crypto';

/**
 * The mock stands in for a provider whose idempotency keys survive restarts.
 * Checkout already uses the order id as the capture key, so a recovery sweep
 * that re-captures after a lost response must get the *original* transaction
 * back. Refunds are keyed by the captured transaction the same way: a retry of
 * a refund stuck between `startRefund` and `markSucceeded` cannot return the
 * money twice.
 */
@Injectable()
export class MockPaymentProvider implements IPaymentProvider {
  private readonly capturesByOrder = new Map<string, string>();
  private readonly refundsByTransaction = new Map<string, string>();

  async capture(
    amount: number,
    orderId: string,
    _metadata?: Record<string, unknown>,
  ): Promise<PaymentResult> {
    if (amount < 0) {
      return {
        success: false,
        errorMessage: 'Invalid payment amount: amount cannot be negative',
      };
    }

    const replayed = this.capturesByOrder.get(orderId);
    if (replayed) return { success: true, transactionId: replayed };

    const transactionId = `mock_tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.capturesByOrder.set(orderId, transactionId);
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

    const replayed = this.refundsByTransaction.get(transactionId);
    if (replayed) return { success: true, transactionId: replayed };

    const reference = `mock_ref_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.refundsByTransaction.set(transactionId, reference);
    return {
      success: true,
      transactionId: reference,
    };
  }
}
