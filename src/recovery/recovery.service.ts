import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CatalogClient } from '../clients/catalog.client.js';
import type { PaymentResult } from '../payments/payment-provider.interface.js';
import { PaymentsService } from '../payments/payments.service.js';
import { RefundsRepository } from '../orders/refunds.repository.js';
import {
  RecoveryRepository,
  type StalePendingCapture,
  type StuckRefund,
} from './recovery.repository.js';

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;

export interface RecoverySweepResult {
  skipped: boolean;
  capturesReclaimed: number;
  refundsSettled: number;
}

/**
 * Reclaims money the checkout saga could not finish itself.
 *
 * A capture whose answer was lost is retried with the order id — the provider
 * idempotency key checkout already used — so the sweep can never take money a
 * second time. A refund stuck after `startRefund` is retried against the same
 * captured transaction and settled only if the ledger row is still pending.
 * Nothing here depends on the customer retrying with the same key.
 */
@Injectable()
export class RecoveryService {
  private readonly logger = new Logger(RecoveryService.name);
  private readonly staleAfterMs: number;
  private readonly batchSize: number;

  constructor(
    private readonly repository: RecoveryRepository,
    private readonly refunds: RefundsRepository,
    private readonly payments: PaymentsService,
    private readonly catalog: CatalogClient,
    config: ConfigService,
  ) {
    this.staleAfterMs = config.get<number>(
      'RECOVERY_STALE_AFTER_MS',
      DEFAULT_STALE_AFTER_MS,
    );
    this.batchSize = config.get<number>(
      'RECOVERY_SWEEP_BATCH_SIZE',
      DEFAULT_BATCH_SIZE,
    );
  }

  /** One sweep cycle; public so tests and one-off tools drive it directly. */
  async sweep(now: Date = new Date()): Promise<RecoverySweepResult> {
    const release = await this.repository.tryAcquireSweepLock();
    if (!release) {
      return { skipped: true, capturesReclaimed: 0, refundsSettled: 0 };
    }

    try {
      const cutoff = new Date(now.getTime() - this.staleAfterMs);
      const [captures, refunds] = await Promise.all([
        this.repository.findStalePendingCaptures(cutoff, this.batchSize),
        this.repository.findStuckRefunds(cutoff, this.batchSize),
      ]);

      let capturesReclaimed = 0;
      for (const capture of captures) {
        if (await this.reclaimCapture(capture)) capturesReclaimed += 1;
      }

      let refundsSettled = 0;
      for (const refund of refunds) {
        if (await this.settleRefund(refund)) refundsSettled += 1;
      }

      if (capturesReclaimed + refundsSettled > 0) {
        this.logger.log(
          `Recovery sweep reclaimed ${capturesReclaimed} capture(s) and settled ${refundsSettled} refund(s)`,
        );
      }
      return { skipped: false, capturesReclaimed, refundsSettled };
    } finally {
      await release();
    }
  }

  private async reclaimCapture(capture: StalePendingCapture): Promise<boolean> {
    let transactionId = capture.transactionId;

    if (!transactionId || capture.paymentStatus !== 'captured') {
      let payment: PaymentResult;
      try {
        payment = await this.payments.processPayment(
          capture.provider,
          capture.grandTotal,
          capture.orderId,
        );
      } catch (error) {
        this.logger.error(
          `Recovery capture for ${capture.orderId} threw`,
          error instanceof Error ? error.stack : error,
        );
        return false;
      }

      if (!payment.success) {
        this.logger.warn(
          `Recovery capture for ${capture.orderId} was declined: ${payment.errorMessage ?? 'no reason given'}`,
        );
        await this.compensate(capture);
        return true;
      }

      transactionId = payment.transactionId ?? `mock_tx_${capture.orderId.slice(0, 12)}`;
    }

    return this.repository.confirmReclaimedCapture(capture, transactionId);
  }

  private async compensate(capture: StalePendingCapture): Promise<void> {
    const closed = await this.repository.closeReclaimedAttempt(
      capture.orderId,
      'Recovery sweep: payment declined, no money captured',
    );
    if (!closed) return;

    if (!capture.reservationId) return;
    try {
      const released = await this.catalog.releaseStock(capture.reservationId);
      if (!released.ok) {
        this.logger.warn(
          `Release of hold ${capture.reservationId} failed (${released.message}); the hold will expire`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Release of hold ${capture.reservationId} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async settleRefund(refund: StuckRefund): Promise<boolean> {
    let result: PaymentResult;
    try {
      result = await this.payments.processRefund(
        refund.transactionId,
        refund.amount,
        refund.reason ?? undefined,
      );
    } catch (error) {
      // A provider outage is not an answer. Leave the ledger pending for the
      // next sweep rather than telling the customer the refund failed.
      this.logger.error(
        `Recovery refund for ${refund.refundId} threw`,
        error instanceof Error ? error.stack : error,
      );
      return false;
    }

    if (!result.success) {
      const reason = result.errorMessage ?? 'Recovery refund was declined';
      try {
        await this.refunds.markFailed(refund.refundId, reason);
      } catch (error) {
        // A concurrent settlement already made this row terminal.
        this.logger.warn(
          `Refund ${refund.refundId} could not be marked failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return true;
    }

    const settled = await this.refunds.settlePending(
      refund.refundId,
      result.transactionId ?? `refund_${refund.refundId}`,
    );
    // Null means another path settled it first; either way it is terminal.
    return settled !== null;
  }
}
