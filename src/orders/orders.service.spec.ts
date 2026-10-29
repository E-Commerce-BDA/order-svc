import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { OrdersRepository, type OrderWithDetails } from './orders.repository.js';
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
      refundOrderWithHistory: vi.fn(),
    };
    service = new OrdersService(repo as unknown as OrdersRepository);
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
  });

  describe('refundOrder', () => {
    it('successfully processes full refund on delivered order', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      repo.refundOrderWithHistory!.mockResolvedValue({
        ...sampleOrder,
        status: 'refunded',
        payment_status: 'refunded',
      });

      const res = await service.refundOrder(
        'ord-123',
        { reason: 'Customer returned item' },
        'admin-1',
      );

      expect(repo.refundOrderWithHistory).toHaveBeenCalledWith(
        'ord-123',
        'delivered',
        '118.00',
        'Customer returned item',
        'admin-1',
      );
      expect(res.status).toBe('refunded');
    });

    it('successfully processes partial refund when amount <= grand_total', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);
      repo.refundOrderWithHistory!.mockResolvedValue({
        ...sampleOrder,
        status: 'refunded',
        payment_status: 'refunded',
      });

      await service.refundOrder(
        'ord-123',
        { amount: 50.0, reason: 'Goodwill partial refund' },
        'admin-1',
      );

      expect(repo.refundOrderWithHistory).toHaveBeenCalledWith(
        'ord-123',
        'delivered',
        '50.00',
        'Goodwill partial refund',
        'admin-1',
      );
    });

    it('rejects refund amount exceeding grand total with BadRequestException', async () => {
      repo.findOrderById!.mockResolvedValue(sampleOrder);

      await expect(
        service.refundOrder('ord-123', { amount: 200.0 }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(repo.refundOrderWithHistory).not.toHaveBeenCalled();
    });

    it('rejects refund when order is not in refundable state', async () => {
      const pendingOrder = { ...sampleOrder, status: 'pending' as const };
      repo.findOrderById!.mockResolvedValue(pendingOrder);

      await expect(
        service.refundOrder('ord-123', { amount: 50.0 }, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
      expect(repo.refundOrderWithHistory).not.toHaveBeenCalled();
    });
  });
});
