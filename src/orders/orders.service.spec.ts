import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersRepository, type OrderWithDetails } from './orders.repository.js';
import { RefundsRepository, type StartRefundInput } from './refunds.repository.js';
import { CatalogClient } from '../clients/catalog.client.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { PaymentRow, RefundRow } from '../db/rows.js';
import {
  assertValidTransition,
  canTransition,
} from './order-state-machine.js';

describe('Order State Machine', () => {
  it('allows valid progressive transitions', () => {
    expect(canTransition('pending', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'processing')).toBe(true);
    expect(canTransition('processing', 'shipped')).toBe(true);
    expect(canTransition('shipped', 'delivered')).toBe(true);
    expect(canTransition('delivered', 'refunded')).toBe(true);
  });

  it('allows valid cancellation transitions', () => {
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('confirmed', 'cancelled')).toBe(true);
    expect(canTransition('processing', 'cancelled')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(canTransition('pending', 'delivered')).toBe(false);
    expect(canTransition('shipped', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'confirmed')).toBe(false);
    expect(canTransition('refunded', 'delivered')).toBe(false);
    expect(canTransition('confirmed', 'confirmed')).toBe(false);
  });

  it('assertValidTransition throws BadRequestException on invalid transitions', () => {
    expect(() => assertValidTransition('pending', 'delivered')).toThrow(
      BadRequestException,
    );
    expect(() => assertValidTransition('shipped', 'processing')).toThrow(
      BadRequestException,
    );
  });
});

describe('OrdersService', () => {
  let service: OrdersService;
  let repo: Partial<Record<keyof OrdersRepository, ReturnType<typeof vi.fn>>>;
  let refunds: Partial<Record<keyof RefundsRepository, ReturnType<typeof vi.fn>>>;
  let payments: { processRefund: ReturnType<typeof vi.fn> };
  let catalog: { releaseStock: ReturnType<typeof vi.fn> };

  const sampleOrder: OrderWithDetails = {
    id: 'ord-123',
    user_id: 'user-abc',
    order_number: '#2026-100001',
    status: 'delivered',
    subtotal: '100.00',
    shipping_fee: '10.00',
    tax: '8.00',
    discount: '0.00',
    grand_total: '118.00',
    currency: 'USD',
    payment_status: 'paid',
    shipping_address: {
      line1: '123 Main St',
      city: 'Metropolis',
      postalCode: '10001',
      country: 'US',
    },
    billing_address: {
      line1: '123 Main St',
      city: 'Metropolis',
      postalCode: '10001',
      country: 'US',
    },
    discount_code_id: null,
    stock_reservation_id: null,
    idempotency_key: null,
    idempotency_body_hash: null,
    notes: null,
    created_at: '2026-10-27T10:00:00Z',
    updated_at: '2026-10-27T10:00:00Z',
    items: [],
    status_history: [],
    payments: [],
  };

  beforeEach(() => {
    repo = {
      findCustomerOrders: vi.fn(),
      findOrderById: vi.fn(),
      findStatusHistory: vi.fn(),
      findAdminOrders: vi.fn(),
      updateStatusWithHistory: vi.fn(),
    };
    refunds = {
      findByOrderId: vi.fn(),
      findCapturedPayment: vi.fn(),
      startRefund: vi.fn(),
      markSucceeded: vi.fn(),
      markFailed: vi.fn(),
    };
    payments = { processRefund: vi.fn() };
    catalog = { releaseStock: vi.fn().mockResolvedValue({ ok: true, status: 'released' }) };
    service = new OrdersService(
      repo as unknown as OrdersRepository,
      refunds as unknown as RefundsRepository,
      catalog as unknown as CatalogClient,
      payments as unknown as PaymentsService,
    );
  });

  describe('findOrderById authorization', () => {
    it('allows owner customer to view their order', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      const res = await service.findOrderById('ord-123', {
        userId: 'user-abc',
        roles: ['customer'],
      });
      expect(res).toEqual(sampleOrder);
    });

    it('allows admin to view any customer order', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      const res = await service.findOrderById('ord-123', {
        userId: 'admin-xyz',
        roles: ['admin'],
      });
      expect(res).toEqual(sampleOrder);
    });

    it('throws ForbiddenException when another customer tries to view order', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      await expect(
        service.findOrderById('ord-123', {
          userId: 'user-hacker',
          roles: ['customer'],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when order does not exist', async () => {
      repo.findOrderById!.mockResolvedValue(null);
      await expect(
        service.findOrderById('ord-999', {
          userId: 'user-abc',
          roles: ['customer'],
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates status when transition is valid', async () => {
      const confirmedOrder = { ...sampleOrder, status: 'confirmed' as const };
      repo.findOrderById!.mockResolvedValue(confirmedOrder);
      repo.updateStatusWithHistory!.mockResolvedValue({
        ...confirmedOrder,
        status: 'processing',
      });

      const res = await service.updateStatus(
        'ord-123',
        { status: 'processing', note: 'Packing items' },
        'admin-1',
      );

      expect(repo.updateStatusWithHistory).toHaveBeenCalledWith(
        'ord-123',
        'confirmed',
        'processing',
        'Packing items',
        'admin-1',
      );
      expect(res.status).toBe('processing');
    });

    it('rejects invalid state transition with BadRequestException', async () => {
      const deliveredOrder = { ...sampleOrder, status: 'delivered' as const };
      repo.findOrderById!.mockResolvedValue(deliveredOrder);

      await expect(
        service.updateStatus(
          'ord-123',
          { status: 'processing', note: 'Invalid rollback' },
          'admin-1',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.updateStatusWithHistory).not.toHaveBeenCalled();
    });

    it('releases the stock hold once the cancellation has committed', async () => {
      const heldOrder = {
        ...sampleOrder,
        status: 'confirmed' as const,
        stock_reservation_id: 'reservation-1',
      };
      repo.findOrderById!.mockResolvedValue(heldOrder);
      repo.updateStatusWithHistory!.mockResolvedValue({ ...heldOrder, status: 'cancelled' });

      await service.updateStatus('ord-123', { status: 'cancelled' }, 'admin-1');

      expect(catalog.releaseStock).toHaveBeenCalledWith('reservation-1');
      expect(repo.updateStatusWithHistory!.mock.invocationCallOrder[0]).toBeLessThan(
        catalog.releaseStock.mock.invocationCallOrder[0],
      );
    });

    it('does not release a hold for a non-terminal transition', async () => {
      const heldOrder = {
        ...sampleOrder,
        status: 'confirmed' as const,
        stock_reservation_id: 'reservation-1',
      };
      repo.findOrderById!.mockResolvedValue(heldOrder);
      repo.updateStatusWithHistory!.mockResolvedValue({ ...heldOrder, status: 'processing' });

      await service.updateStatus('ord-123', { status: 'processing' }, 'admin-1');

      expect(catalog.releaseStock).not.toHaveBeenCalled();
    });

    it('still returns the order when the hold cannot be released', async () => {
      const heldOrder = {
        ...sampleOrder,
        status: 'confirmed' as const,
        stock_reservation_id: 'reservation-1',
      };
      repo.findOrderById!.mockResolvedValue(heldOrder);
      repo.updateStatusWithHistory!.mockResolvedValue({ ...heldOrder, status: 'cancelled' });
      catalog.releaseStock.mockRejectedValueOnce(new Error('catalog is down'));

      const res = await service.updateStatus('ord-123', { status: 'cancelled' }, 'admin-1');

      expect(res.status).toBe('cancelled');
    });
  });

  describe('refundOrder', () => {
    const capturedPaymentRow: PaymentRow = {
      id: 'pay-123',
      order_id: 'ord-123',
      provider: 'mock',
      amount: '118.00',
      status: 'captured',
      transaction_id: 'mock_tx_seed',
      paid_at: '2026-10-27T10:00:00Z',
      created_at: '2026-10-27T10:00:00Z',
      updated_at: '2026-10-27T10:00:00Z',
    };

    const refundRow = (overrides: Partial<RefundRow> = {}): RefundRow => ({
      id: 'refund-123',
      order_id: 'ord-123',
      payment_id: 'pay-123',
      amount: '118.00',
      status: 'pending',
      provider_reference: null,
      failure_reason: null,
      reason: 'Customer returned item',
      requested_by: 'admin-1',
      created_at: '2026-10-30T10:00:00Z',
      updated_at: '2026-10-30T10:00:00Z',
      ...overrides,
    });

    const refundedOrder = (): OrderWithDetails => ({
      ...sampleOrder,
      status: 'refunded',
      payment_status: 'refunded',
    });

    /** Every refund failure is asserted on its status *and* its machine code. */
    const rejection = async (promise: Promise<unknown>): Promise<HttpException> => {
      try {
        await promise;
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return error;
      }
      throw new Error('Expected the promise to reject with an HttpException');
    };

    const allowRefund = (): void => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(null);
      refunds.findCapturedPayment!.mockResolvedValue(capturedPaymentRow);
      refunds.startRefund!.mockImplementation((input: StartRefundInput) =>
        Promise.resolve({
          // Echo the reservation back the way Postgres would: the provider must be
          // asked for the amount the ledger reserved, not for the DTO's amount.
          refund: refundRow({
            amount: input.amount.toFixed(2),
            reason: input.reason,
            requested_by: input.requestedBy,
          }),
          created: true,
        }),
      );
      payments.processRefund!.mockResolvedValue({
        success: true,
        transactionId: 'mock_ref_1',
      });
      refunds.markSucceeded!.mockImplementation(
        (_id: string, reference: string) =>
          Promise.resolve({
            refund: refundRow({ status: 'succeeded', provider_reference: reference }),
            order: refundedOrder(),
          }),
      );
    };

    it('refunds through the provider and settles the ledger in one step', async () => {
      allowRefund();

      const res = await service.refundOrder(
        'ord-123',
        { reason: 'Customer returned item' },
        'admin-1',
      );

      expect(refunds.startRefund).toHaveBeenCalledWith({
        orderId: 'ord-123',
        paymentId: 'pay-123',
        amount: 118,
        reason: 'Customer returned item',
        requestedBy: 'admin-1',
      });
      // The transaction id has to come from the payment row: it is the only
      // handle the provider recognises.
      expect(payments.processRefund).toHaveBeenCalledWith(
        'mock_tx_seed',
        118,
        'Customer returned item',
      );
      expect(refunds.markSucceeded).toHaveBeenCalledWith('refund-123', 'mock_ref_1');
      expect(res.order.status).toBe('refunded');
      expect(res.refund.status).toBe('succeeded');
    });

    it('refunds the requested amount when it is below the grand total', async () => {
      allowRefund();

      await service.refundOrder(
        'ord-123',
        { amount: 50, reason: 'Goodwill partial refund' },
        'admin-1',
      );

      expect(refunds.startRefund).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50 }),
      );
      expect(payments.processRefund).toHaveBeenCalledWith(
        'mock_tx_seed',
        50,
        'Goodwill partial refund',
      );
    });

    it('rejects a refund larger than the grand total before touching the ledger', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(null);

      await expect(
        service.refundOrder('ord-123', { amount: 200 }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(refunds.startRefund).not.toHaveBeenCalled();
      expect(payments.processRefund).not.toHaveBeenCalled();
    });

    it('rejects a refund on an order that cannot be refunded yet', async () => {
      repo.findOrderById!.mockResolvedValue({ ...sampleOrder, status: 'pending' });
      refunds.findByOrderId!.mockResolvedValue(null);

      await expect(
        service.refundOrder('ord-123', { amount: 50 }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(refunds.startRefund).not.toHaveBeenCalled();
    });

    it('replays a settled refund without calling the provider again', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(
        refundRow({ status: 'succeeded', provider_reference: 'mock_ref_earlier' }),
      );

      const res = await service.refundOrder('ord-123', {}, 'admin-1');

      expect(res.refund.provider_reference).toBe('mock_ref_earlier');
      expect(refunds.startRefund).not.toHaveBeenCalled();
      expect(payments.processRefund).not.toHaveBeenCalled();
    });

    it('refuses a second refund while one is still in flight', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(refundRow({ status: 'pending' }));

      const error = await rejection(service.refundOrder('ord-123', {}, 'admin-1'));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'REFUND_IN_PROGRESS' });
      expect(payments.processRefund).not.toHaveBeenCalled();
    });

    it('refuses the loser of a concurrent double refund', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(null);
      refunds.findCapturedPayment!.mockResolvedValue(capturedPaymentRow);
      // The other request inserted first, so this insert hit the unique index.
      refunds.startRefund!.mockResolvedValue({
        refund: refundRow({ status: 'pending' }),
        created: false,
      });

      const error = await rejection(service.refundOrder('ord-123', {}, 'admin-1'));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'REFUND_IN_PROGRESS' });
      expect(payments.processRefund).not.toHaveBeenCalled();
    });

    it('refuses a refund when no payment was ever captured', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(null);
      refunds.findCapturedPayment!.mockResolvedValue(null);

      const error = await rejection(service.refundOrder('ord-123', {}, 'admin-1'));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'NO_CAPTURED_PAYMENT' });
      expect(refunds.startRefund).not.toHaveBeenCalled();
    });

    it('records the ledger failure when the provider declines the refund', async () => {
      allowRefund();
      payments.processRefund!.mockResolvedValue({
        success: false,
        errorMessage: 'Refund window closed',
      });

      const error = await rejection(service.refundOrder('ord-123', {}, 'admin-1'));

      expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(error.getResponse()).toMatchObject({ code: 'REFUND_PROVIDER_FAILED' });
      expect(refunds.markFailed).toHaveBeenCalledWith('refund-123', 'Refund window closed');
      expect(refunds.markSucceeded).not.toHaveBeenCalled();
    });

    it('records the ledger failure when the provider is unreachable', async () => {
      allowRefund();
      payments.processRefund!.mockRejectedValue(new Error('socket hang up'));

      const error = await rejection(service.refundOrder('ord-123', {}, 'admin-1'));

      expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(refunds.markFailed).toHaveBeenCalledWith(
        'refund-123',
        'Payment provider unreachable',
      );
      expect(refunds.markSucceeded).not.toHaveBeenCalled();
    });

    it('retries a failed refund with the amount it was reserved for', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      refunds.findByOrderId!.mockResolvedValue(
        refundRow({ status: 'failed', amount: '50.00', failure_reason: 'Timeout' }),
      );
      refunds.findCapturedPayment!.mockResolvedValue(capturedPaymentRow);
      payments.processRefund!.mockResolvedValue({
        success: true,
        transactionId: 'mock_ref_2',
      });
      refunds.markSucceeded!.mockResolvedValue({
        refund: refundRow({ status: 'succeeded', amount: '50.00' }),
        order: refundedOrder(),
      });

      await service.refundOrder('ord-123', { amount: 118 }, 'admin-1');

      // Not 118: the reserved amount is what the customer was promised.
      expect(payments.processRefund).toHaveBeenCalledWith(
        'mock_tx_seed',
        50,
        'Customer returned item',
      );
      expect(refunds.startRefund).not.toHaveBeenCalled();
    });
  });
});
