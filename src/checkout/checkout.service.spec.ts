import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CheckoutService } from './checkout.service.js';
import { RedisService } from '../redis/redis.service.js';
import { CatalogClient } from '../clients/catalog.client.js';
import { CartClient } from '../clients/cart.client.js';
import { DiscountsService } from '../discounts/discounts.service.js';
import { DiscountsRepository } from '../discounts/discounts.repository.js';
import { PaymentsService } from '../payments/payments.service.js';
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutDto } from './dto/checkout.dto.js';
import * as dbPool from '../db/pool.js';

describe('CheckoutService', () => {
  let service: CheckoutService;
  let mockRedis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    setnx: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let mockCatalogClient: {
    reserveStock: ReturnType<typeof vi.fn>;
    releaseStock: ReturnType<typeof vi.fn>;
    getProductSnapshots: ReturnType<typeof vi.fn>;
  };
  let mockCartClient: {
    clearCart: ReturnType<typeof vi.fn>;
  };
  let mockDiscountsService: {
    validate: ReturnType<typeof vi.fn>;
  };
  let mockDiscountsRepository: {
    incrementUsesCount: ReturnType<typeof vi.fn>;
  };
  let mockPaymentsService: {
    processPayment: ReturnType<typeof vi.fn>;
  };
  let mockPoolClient: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mockPool: {
    connect: ReturnType<typeof vi.fn>;
  };

  const createSampleDto = (): CheckoutDto => ({
    items: [
      {
        productId: '018f0000-0000-7000-8000-000000000101',
        qty: 2,
      },
    ],
    shippingAddress: {
      line1: '123 Main St',
      city: 'Seattle',
      postalCode: '98101',
      country: 'US',
    },
    billingAddress: {
      line1: '123 Main St',
      city: 'Seattle',
      postalCode: '98101',
      country: 'US',
    },
    payment: {
      provider: 'mock',
    },
  });

  beforeEach(() => {
    mockRedis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      setnx: vi.fn().mockResolvedValue(true),
      del: vi.fn().mockResolvedValue(undefined),
    };

    mockCatalogClient = {
      reserveStock: vi.fn().mockResolvedValue({ success: true, reservedItems: 2 }),
      releaseStock: vi.fn().mockResolvedValue({ success: true, releasedCount: 2 }),
      getProductSnapshots: vi.fn().mockResolvedValue(new Map()),
    };

    mockCartClient = {
      clearCart: vi.fn().mockResolvedValue(undefined),
    };

    mockDiscountsService = {
      validate: vi.fn().mockResolvedValue({ valid: true, discount: 10, id: 'coupon-1' }),
    };

    mockDiscountsRepository = {
      incrementUsesCount: vi.fn().mockResolvedValue(true),
    };

    mockPaymentsService = {
      processPayment: vi.fn().mockResolvedValue({
        success: true,
        transactionId: 'mock_tx_123',
      }),
    };

    mockPoolClient = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'order-123' }] }),
      release: vi.fn(),
    };

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockPoolClient),
    };

    vi.spyOn(dbPool, 'getPool').mockReturnValue(mockPool as any);

    service = new CheckoutService(
      mockRedis as unknown as RedisService,
      mockCatalogClient as unknown as CatalogClient,
      mockCartClient as unknown as CartClient,
      mockDiscountsService as unknown as DiscountsService,
      mockDiscountsRepository as unknown as DiscountsRepository,
      mockPaymentsService as unknown as PaymentsService,
    );
  });

  it('throws BadRequestException if idempotency key is missing', async () => {
    await expect(
      service.checkout('user-1', '', createSampleDto()),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns cached response immediately on idempotency hit with matching payload', async () => {
    const cachedResponse = {
      orderId: 'cached-order-1',
      orderNumber: '#2026-999999',
      status: 'confirmed',
      totals: { subtotal: 100, shipping: 0, tax: 0, discount: 0, grandTotal: 100 },
      items: [],
    };

    // Calculate exact hash for the dto
    const { createHash } = await import('node:crypto');
    const dto = createSampleDto();
    const bodyHash = createHash('sha256').update(JSON.stringify(dto)).digest('hex');

    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ bodyHash, response: cachedResponse }),
    );

    const result = await service.checkout('user-1', 'key-123', dto);
    expect(result).toEqual(cachedResponse);
    expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
  });

  it('throws ConflictException on idempotency conflict with mismatched payload', async () => {
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({ bodyHash: 'different-hash', response: {} }),
    );

    await expect(
      service.checkout('user-1', 'key-123', createSampleDto()),
    ).rejects.toThrow(ConflictException);
  });

  it('throws ConflictException when stock reservation in catalog-svc fails', async () => {
    mockCatalogClient.reserveStock.mockResolvedValueOnce({
      success: false,
      errorMessage: 'One or more items are out of stock',
    });

    await expect(
      service.checkout('user-1', 'key-123', createSampleDto()),
    ).rejects.toThrow(ConflictException);

    expect(mockRedis.del).toHaveBeenCalledWith('idem:key-123:lock');
    expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
  });

  it('compensates and releases stock when discount coupon is invalid', async () => {
    const dto = createSampleDto();
    dto.discountCode = 'INVALIDCODE';

    mockDiscountsService.validate.mockResolvedValueOnce({
      valid: false,
      message: 'Discount code has expired',
    });

    await expect(
      service.checkout('user-1', 'key-123', dto),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(mockCatalogClient.releaseStock).toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith('idem:key-123:lock');
    expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
  });

  it('compensates and releases stock when payment capture fails', async () => {
    mockPaymentsService.processPayment.mockResolvedValueOnce({
      success: false,
      errorMessage: 'Declined by issuer',
    });

    await expect(
      service.checkout('user-1', 'key-123', createSampleDto()),
    ).rejects.toThrow(BadRequestException);

    expect(mockCatalogClient.releaseStock).toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith('idem:key-123:lock');
  });

  it('completes full checkout atomically, caches in redis, and returns confirmation', async () => {
    const dto = createSampleDto();
    const result = await service.checkout('user-1', 'key-123', dto);

    expect(result.orderId).toBe('order-123');
    expect(result.status).toBe('confirmed');
    expect(result.orderNumber).toMatch(/^#2026-\d{6}$/);

    expect(mockPoolClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockPoolClient.query).toHaveBeenCalledWith('COMMIT');
    expect(mockRedis.set).toHaveBeenCalled();
    expect(mockRedis.del).toHaveBeenCalledWith('idem:key-123:lock');
  });
});
