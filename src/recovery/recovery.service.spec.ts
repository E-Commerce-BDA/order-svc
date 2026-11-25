import { ConfigService } from '@nestjs/config';
import { CatalogClient } from '../clients/catalog.client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { RefundsRepository } from '../orders/refunds.repository.js';
import {
  RecoveryRepository,
  type StalePendingCapture,
  type StuckRefund,
} from './recovery.repository.js';
import { RecoveryService } from './recovery.service.js';

const NOW = new Date('2026-11-25T12:00:00Z');

describe('RecoveryService', () => {
  let service: RecoveryService;
  let repository: {
    tryAcquireSweepLock: ReturnType<typeof vi.fn>;
    findStalePendingCaptures: ReturnType<typeof vi.fn>;
    findStuckRefunds: ReturnType<typeof vi.fn>;
    confirmReclaimedCapture: ReturnType<typeof vi.fn>;
    closeReclaimedAttempt: ReturnType<typeof vi.fn>;
  };
  let refunds: { settlePending: ReturnType<typeof vi.fn>; markFailed: ReturnType<typeof vi.fn> };
  let payments: { processPayment: ReturnType<typeof vi.fn>; processRefund: ReturnType<typeof vi.fn> };
  let catalog: { releaseStock: ReturnType<typeof vi.fn> };
  let release: ReturnType<typeof vi.fn>;

  const capture = (overrides: Partial<StalePendingCapture> = {}): StalePendingCapture => ({
    orderId: 'order-1',
    orderNumber: '#2026-100001',
    userId: 'user-1',
    grandTotal: 100,
    itemsCount: 2,
    reservationId: 'reservation-1',
    createdAt: '2026-11-25T11:00:00.000Z',
    paymentId: 'payment-1',
    provider: 'mock',
    paymentStatus: 'pending',
    transactionId: null,
    ...overrides,
  });

  const refund = (): StuckRefund => ({
    refundId: 'refund-1',
    amount: 100,
    reason: 'Changed mind',
    transactionId: 'mock_tx_seed',
  });

  beforeEach(() => {
    release = vi.fn().mockResolvedValue(undefined);
    repository = {
      tryAcquireSweepLock: vi.fn().mockResolvedValue(release),
      findStalePendingCaptures: vi.fn().mockResolvedValue([]),
      findStuckRefunds: vi.fn().mockResolvedValue([]),
      confirmReclaimedCapture: vi.fn().mockResolvedValue(true),
      closeReclaimedAttempt: vi.fn().mockResolvedValue(true),
    };
    refunds = {
      settlePending: vi.fn().mockResolvedValue({ refund: {}, order: {} }),
      markFailed: vi.fn().mockResolvedValue({}),
    };
    payments = {
      processPayment: vi.fn().mockResolvedValue({
        success: true,
        transactionId: 'mock_tx_replayed',
      }),
      processRefund: vi.fn().mockResolvedValue({
        success: true,
        transactionId: 'mock_ref_replayed',
      }),
    };
    catalog = { releaseStock: vi.fn().mockResolvedValue({ ok: true, status: 'released' }) };

    service = new RecoveryService(
      repository as unknown as RecoveryRepository,
      refunds as unknown as RefundsRepository,
      payments as unknown as PaymentsService,
      catalog as unknown as CatalogClient,
      { get: vi.fn().mockImplementation((_key: string, fallback: number) => fallback) } as unknown as ConfigService,
    );
  });

  it('skips the sweep when another instance holds the leader lock', async () => {
    repository.tryAcquireSweepLock.mockResolvedValue(null);

    const result = await service.sweep(NOW);

    expect(result).toEqual({
      skipped: true,
      capturesReclaimed: 0,
      refundsSettled: 0,
    });
    expect(repository.findStalePendingCaptures).not.toHaveBeenCalled();
    expect(repository.findStuckRefunds).not.toHaveBeenCalled();
  });

  it('re-captures a lost answer with the order id and commits TX2', async () => {
    repository.findStalePendingCaptures.mockResolvedValue([capture()]);

    const result = await service.sweep(NOW);

    expect(result.capturesReclaimed).toBe(1);
    expect(payments.processPayment).toHaveBeenCalledWith('mock', 100, 'order-1');
    expect(repository.confirmReclaimedCapture).toHaveBeenCalledWith(
      capture(),
      'mock_tx_replayed',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not call the provider when the capture is already in the ledger', async () => {
    repository.findStalePendingCaptures.mockResolvedValue([
      capture({ paymentStatus: 'captured', transactionId: 'mock_tx_original' }),
    ]);

    const result = await service.sweep(NOW);

    expect(result.capturesReclaimed).toBe(1);
    expect(payments.processPayment).not.toHaveBeenCalled();
    expect(repository.confirmReclaimedCapture).toHaveBeenCalledWith(
      capture({ paymentStatus: 'captured', transactionId: 'mock_tx_original' }),
      'mock_tx_original',
    );
  });

  it('closes the attempt and releases the hold when the capture is declined', async () => {
    repository.findStalePendingCaptures.mockResolvedValue([capture()]);
    payments.processPayment.mockResolvedValue({
      success: false,
      errorMessage: 'Insufficient funds',
    });

    const result = await service.sweep(NOW);

    expect(result.capturesReclaimed).toBe(1);
    expect(repository.confirmReclaimedCapture).not.toHaveBeenCalled();
    expect(repository.closeReclaimedAttempt).toHaveBeenCalledWith(
      'order-1',
      expect.stringContaining('declined'),
    );
    expect(catalog.releaseStock).toHaveBeenCalledWith('reservation-1');
  });

  it('leaves a capture pending when the provider throws', async () => {
    repository.findStalePendingCaptures.mockResolvedValue([capture()]);
    payments.processPayment.mockRejectedValue(new Error('socket hang up'));

    const result = await service.sweep(NOW);

    expect(result.capturesReclaimed).toBe(0);
    expect(repository.closeReclaimedAttempt).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('settles a stuck refund through the provider and marks the ledger terminal', async () => {
    repository.findStuckRefunds.mockResolvedValue([refund()]);

    const result = await service.sweep(NOW);

    expect(result.refundsSettled).toBe(1);
    expect(payments.processRefund).toHaveBeenCalledWith(
      'mock_tx_seed',
      100,
      'Changed mind',
    );
    expect(refunds.settlePending).toHaveBeenCalledWith('refund-1', 'mock_ref_replayed');
    expect(refunds.markFailed).not.toHaveBeenCalled();
  });

  it('does not double-count a refund another path already settled', async () => {
    repository.findStuckRefunds.mockResolvedValue([refund()]);
    refunds.settlePending.mockResolvedValue(null);

    const result = await service.sweep(NOW);

    expect(result.refundsSettled).toBe(0);
    expect(refunds.settlePending).toHaveBeenCalledTimes(1);
  });

  it('leaves a refund pending when the provider is unreachable', async () => {
    repository.findStuckRefunds.mockResolvedValue([refund()]);
    payments.processRefund.mockRejectedValue(new Error('socket hang up'));

    const result = await service.sweep(NOW);

    expect(result.refundsSettled).toBe(0);
    expect(refunds.markFailed).not.toHaveBeenCalled();
    expect(refunds.settlePending).not.toHaveBeenCalled();
  });

  it('marks a declined refund failed so the endpoint stops answering 409', async () => {
    repository.findStuckRefunds.mockResolvedValue([refund()]);
    payments.processRefund.mockResolvedValue({
      success: false,
      errorMessage: 'Refund window closed',
    });

    const result = await service.sweep(NOW);

    expect(result.refundsSettled).toBe(1);
    expect(refunds.markFailed).toHaveBeenCalledWith('refund-1', 'Refund window closed');
    expect(refunds.settlePending).not.toHaveBeenCalled();
  });
});
