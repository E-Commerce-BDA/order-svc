import { createHash } from 'node:crypto';
import {
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutService } from './checkout.service.js';
import { RedisService } from '../redis/redis.service.js';
import { CatalogClient } from '../clients/catalog.client.js';
import { CartClient } from '../clients/cart.client.js';
import { DiscountsService } from '../discounts/discounts.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import { canonicalJson } from '../common/canonical-json.js';
import {
  CheckoutRepository,
  DuplicateIdempotencyKeyError,
  type OutboxWrite,
} from './checkout.repository.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import type { OrderItemRow, OrderRow, PaymentRow } from '../db/rows.js';

const USER_ID = 'user-1';
const KEY = 'key-123';
const CACHE_KEY = `idem:${USER_ID}:checkout:${KEY}`;
const LOCK_KEY = `${CACHE_KEY}:lock`;

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
  let mockCartClient: { convertCart: ReturnType<typeof vi.fn> };
  let mockDiscountsService: { validate: ReturnType<typeof vi.fn> };
  let mockPaymentsService: {
    processPayment: ReturnType<typeof vi.fn>;
    processRefund: ReturnType<typeof vi.fn>;
  };
  let mockRepository: {
    findByIdempotencyKey: ReturnType<typeof vi.fn>;
    createOrder: ReturnType<typeof vi.fn>;
    findPendingPayment: ReturnType<typeof vi.fn>;
    confirmOrder: ReturnType<typeof vi.fn>;
    failOrder: ReturnType<typeof vi.fn>;
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

  const bodyHashOf = (dto: CheckoutDto): string =>
    createHash('sha256').update(canonicalJson(dto)).digest('hex');

  const storedOrder = (overrides: Partial<OrderRow> = {}): OrderRow => ({
    id: 'order-123',
    user_id: USER_ID,
    order_number: '#2026-123456',
    status: 'confirmed',
    subtotal: '160.00',
    shipping_fee: '0.00',
    tax: '0.00',
    discount: '0.00',
    grand_total: '160.00',
    currency: 'USD',
    payment_status: 'paid',
    shipping_address: {
      line1: '123 Main St',
      city: 'Seattle',
      postalCode: '98101',
      country: 'US',
    },
    billing_address: {
      line1: '123 Main St',
      city: 'Seattle',
      postalCode: '98101',
      country: 'US',
    },
    discount_code_id: null,
    stock_reservation_id: 'reservation-1',
    idempotency_key: KEY,
    idempotency_body_hash: bodyHashOf(createSampleDto()),
    notes: null,
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    ...overrides,
  });

  const storedItem = (): OrderItemRow => ({
    id: 'item-1',
    order_id: 'order-123',
    product_id: '018f0000-0000-7000-8000-000000000101',
    variant_id: null,
    product_name: 'Running Shoe Pro',
    sku: 'RSP-BLK-42',
    unit_price: '80.00',
    qty: 2,
    line_total: '160.00',
    options: null,
  });

  const pendingPayment = (overrides: Partial<PaymentRow> = {}): PaymentRow => ({
    id: 'payment-1',
    order_id: 'order-123',
    provider: 'mock',
    amount: '160.00',
    status: 'pending',
    transaction_id: null,
    paid_at: null,
    created_at: '2026-10-29T10:00:00Z',
    updated_at: '2026-10-29T10:00:00Z',
    ...overrides,
  });

  /** Every saga failure is asserted on its status *and* its machine code. */
  const rejection = async (promise: Promise<unknown>): Promise<HttpException> => {
    try {
      await promise;
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return error;
    }
    throw new Error('Expected the promise to reject with an HttpException');
  };

  const cachedPayload = (
    dto: CheckoutDto,
    overrides: Partial<{ bodyHash: string; orderId: string }> = {},
  ): string =>
    JSON.stringify({
      bodyHash: overrides.bodyHash ?? bodyHashOf(dto),
      response: {
        orderId: overrides.orderId ?? 'order-123',
        orderNumber: '#2026-123456',
        status: 'confirmed',
        totals: { subtotal: 160, shipping: 0, tax: 0, discount: 0, grandTotal: 160 },
        items: [
          {
            productId: '018f0000-0000-7000-8000-000000000101',
            productName: 'Running Shoe Pro',
            sku: 'RSP-BLK-42',
            unitPrice: 80,
            qty: 2,
            lineTotal: 160,
          },
        ],
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
      reserveStock: vi.fn().mockResolvedValue({
        ok: true,
        reservationId: 'reservation-1',
        status: 'held',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        items: [
          {
            productId: '018f0000-0000-7000-8000-000000000101',
            variantId: null,
            quantity: 2,
            remainingStock: 8,
          },
        ],
      }),
      releaseStock: vi.fn().mockResolvedValue({ ok: true, status: 'released' }),
      getProductSnapshots: vi.fn().mockResolvedValue(
        new Map([
          [
            '018f0000-0000-7000-8000-000000000101',
            {
              productId: '018f0000-0000-7000-8000-000000000101',
              variantId: null,
              productName: 'Running Shoe Pro',
              sku: 'RSP-BLK-42',
              unitPrice: 80,
              effectivePrice: 80,
              available: true,
              stock: 25,
            },
          ],
        ]),
      ),
    };

    mockCartClient = { convertCart: vi.fn().mockResolvedValue(undefined) };

    mockDiscountsService = {
      validate: vi.fn().mockResolvedValue({ valid: true, discount: 10, id: 'coupon-1' }),
    };

    mockPaymentsService = {
      processPayment: vi.fn().mockResolvedValue({
        success: true,
        transactionId: 'mock_tx_123',
      }),
      processRefund: vi.fn().mockResolvedValue({ success: true, transactionId: 'mock_ref_123' }),
    };

    mockRepository = {
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      createOrder: vi
        .fn()
        .mockResolvedValue({ orderId: 'order-123', orderNumber: '#2026-123456' }),
      findPendingPayment: vi.fn().mockResolvedValue(null),
      confirmOrder: vi
        .fn()
        .mockResolvedValue({ orderId: 'order-123', orderNumber: '#2026-123456' }),
      failOrder: vi.fn().mockResolvedValue(true),
    };

    service = new CheckoutService(
      mockRedis as unknown as RedisService,
      mockCatalogClient as unknown as CatalogClient,
      mockCartClient as unknown as CartClient,
      mockDiscountsService as unknown as DiscountsService,
      mockPaymentsService as unknown as PaymentsService,
      mockRepository as unknown as CheckoutRepository,
    );
  });

  describe('idempotency guard', () => {
    it('scopes the cache key by user and route', async () => {
      await service.checkout(USER_ID, KEY, createSampleDto());

      expect(mockRedis.get).toHaveBeenCalledWith(CACHE_KEY);
      expect(mockRedis.setnx).toHaveBeenCalledWith(LOCK_KEY, 'processing', 60);
      expect(mockRedis.set).toHaveBeenCalledWith(
        CACHE_KEY,
        expect.any(String),
        86_400,
      );
    });

    it('replays the cached response when the order row confirms it', async () => {
      const dto = createSampleDto();
      mockRedis.get.mockResolvedValue(cachedPayload(dto));
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder(),
        items: [storedItem()],
      });

      const result = await service.checkout(USER_ID, KEY, dto);

      expect(result.orderId).toBe('order-123');
      expect(mockRepository.createOrder).not.toHaveBeenCalled();
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    });

    it('rejects a cached key reused with a different body', async () => {
      const dto = createSampleDto();
      mockRedis.get.mockResolvedValue(cachedPayload(dto, { bodyHash: 'a'.repeat(64) }));

      await expect(service.checkout(USER_ID, KEY, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    });

    it('treats an unparseable cache entry as a miss instead of failing or continuing blindly', async () => {
      const dto = createSampleDto();
      mockRedis.get.mockResolvedValue('{not json');

      const result = await service.checkout(USER_ID, KEY, dto);

      expect(result.orderId).toBe('order-123');
      expect(mockRepository.findByIdempotencyKey).toHaveBeenCalledWith(USER_ID, KEY);
      expect(mockRepository.createOrder).toHaveBeenCalledTimes(1);
    });

    it('ignores a cache entry whose order row no longer exists', async () => {
      const dto = createSampleDto();
      mockRedis.get.mockResolvedValue(cachedPayload(dto));
      mockRepository.findByIdempotencyKey.mockResolvedValue(null);

      await service.checkout(USER_ID, KEY, dto);

      expect(mockRepository.createOrder).toHaveBeenCalledTimes(1);
    });

    it('replays from the database when the cache is empty', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder(),
        items: [storedItem()],
      });

      const result = await service.checkout(USER_ID, KEY, createSampleDto());

      expect(result.orderId).toBe('order-123');
      expect(result.totals.grandTotal).toBe(160);
      expect(result.items[0].sku).toBe('RSP-BLK-42');
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    });

    it('rejects a key whose attempt already ended as failed', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder({ status: 'failed' }),
        items: [storedItem()],
      });

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ConflictException);
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    });

    it('rejects a stored attempt with a different body hash', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder({ idempotency_body_hash: 'b'.repeat(64) }),
        items: [storedItem()],
      });

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ConflictException);
    });

    it('fails closed with 503 when the cache read errors', async () => {
      mockRedis.get.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
      expect(mockRepository.createOrder).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the lock cannot be taken because redis is down', async () => {
      mockRedis.setnx.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
    });

    it('rejects a concurrent duplicate with 409 while another attempt holds the lock', async () => {
      mockRedis.setnx.mockResolvedValue(false);

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ConflictException);
      expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
    });

    it('still returns the order when the post-commit cache write fails', async () => {
      mockRedis.set.mockRejectedValue(new Error('READONLY replica'));

      const result = await service.checkout(USER_ID, KEY, createSampleDto());

      expect(result.orderId).toBe('order-123');
      expect(result.status).toBe('confirmed');
    });

    it('serves the winner and releases only its own hold on a duplicate-key race', async () => {
      mockRepository.createOrder.mockRejectedValueOnce(
        new DuplicateIdempotencyKeyError(KEY),
      );
      mockRepository.findByIdempotencyKey
        .mockResolvedValueOnce(null)
        .mockResolvedValue({ order: storedOrder(), items: [storedItem()] });

      const result = await service.checkout(USER_ID, KEY, createSampleDto());

      expect(result.orderId).toBe('order-123');
      // Nothing was captured: the insert is now the first durable write, so the
      // loser of the race has no money to refund.
      expect(mockPaymentsService.processRefund).not.toHaveBeenCalled();
      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
    });

    it('releases the lock on every path', async () => {
      mockCatalogClient.reserveStock.mockResolvedValueOnce({
        ok: false,
        failure: 'insufficient_stock',
        code: 'INSUFFICIENT_STOCK',
        message: 'no stock',
      });

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ConflictException);
      expect(mockRedis.del).toHaveBeenCalledWith(LOCK_KEY);
    });
  });

  describe('pending-first payment saga', () => {
    it('persists a pending order before it captures, then confirms it', async () => {
      const dto = createSampleDto();
      const result = await service.checkout(USER_ID, KEY, dto);

      expect(result.orderId).toBe('order-123');
      expect(result.status).toBe('confirmed');
      expect(result.orderNumber).toMatch(/^#2026-\d{6}$/);
      expect(result.totals.grandTotal).toBe(160);

      // TX1 — the row exists as `pending`, with no money and no event yet.
      expect(mockRepository.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          status: 'pending',
          paymentStatus: 'pending',
          idempotencyKey: KEY,
          idempotencyBodyHash: bodyHashOf(dto),
          stockReservationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          grandTotal: 160,
          payment: expect.objectContaining({ status: 'pending', transactionId: null }),
          outbox: null,
        }),
      );

      // The provider key is the order id, so a resumed attempt re-charges nothing.
      expect(mockPaymentsService.processPayment).toHaveBeenCalledWith(
        'mock',
        160,
        'order-123',
      );
      expect(mockRepository.createOrder.mock.invocationCallOrder[0]).toBeLessThan(
        mockPaymentsService.processPayment.mock.invocationCallOrder[0],
      );

      // TX2 — the confirmation carries the capture and the outbox event.
      expect(mockRepository.confirmOrder).toHaveBeenCalledWith(
        'order-123',
        { transactionId: 'mock_tx_123' },
        expect.objectContaining({ topic: 'order.created' }),
      );

      const outbox = mockRepository.confirmOrder.mock.calls[0][2] as OutboxWrite;
      expect(
        outbox.payload({ orderId: 'order-123', orderNumber: '#2026-123456' }),
      ).toMatchObject({
        orderId: 'order-123',
        orderNumber: '#2026-123456',
        userId: USER_ID,
        grandTotal: 160,
        itemsCount: 1,
        reservationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    });

    it('closes the attempt as failed and releases the hold when the capture is declined', async () => {
      mockPaymentsService.processPayment.mockResolvedValueOnce({
        success: false,
        errorMessage: 'Declined by issuer',
      });

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(error.getResponse()).toMatchObject({ code: 'PAYMENT_FAILED' });
      expect(mockRepository.failOrder).toHaveBeenCalledWith(
        'order-123',
        expect.any(String),
        'failed',
      );
      expect(mockRepository.confirmOrder).not.toHaveBeenCalled();
      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.processRefund).not.toHaveBeenCalled();
    });

    it('leaves the attempt pending when the provider is unreachable, so a retry can resume', async () => {
      mockPaymentsService.processPayment.mockRejectedValueOnce(
        new Error('socket hang up'),
      );

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toMatchObject({ code: 'PAYMENT_UNAVAILABLE' });
      // The hold must outlive the failure: a released hold under a pending order
      // would let the resume confirm stock that is already gone.
      expect(mockCatalogClient.releaseStock).not.toHaveBeenCalled();
      expect(mockRepository.failOrder).not.toHaveBeenCalled();
    });

    it('fails closed with 503 and releases the hold when the order cannot be written', async () => {
      mockRepository.createOrder.mockRejectedValueOnce(new Error('connection reset'));

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toMatchObject({ code: 'CHECKOUT_UNAVAILABLE' });
      expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
    });

    it('refunds the capture, closes the order and releases the hold when TX2 fails', async () => {
      mockRepository.confirmOrder.mockRejectedValueOnce(new Error('deadlock detected'));

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(error.getResponse()).toMatchObject({ code: 'PAYMENT_PERSIST_FAILED' });
      expect(mockPaymentsService.processRefund).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.processRefund).toHaveBeenCalledWith(
        'mock_tx_123',
        160,
        expect.stringContaining('confirm'),
      );
      expect(mockRepository.failOrder).toHaveBeenCalledWith(
        'order-123',
        expect.any(String),
        'refunded',
      );
      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
    });

    it('resumes a pending attempt instead of refusing the retry', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder({ status: 'pending', payment_status: 'pending' }),
        items: [storedItem()],
      });
      mockRepository.findPendingPayment.mockResolvedValue(pendingPayment());

      const result = await service.checkout(USER_ID, KEY, createSampleDto());

      expect(result.status).toBe('confirmed');
      expect(result.orderId).toBe('order-123');
      // Same order, same hold, one capture: no new reservation and no new row.
      expect(mockCatalogClient.reserveStock).not.toHaveBeenCalled();
      expect(mockRepository.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentsService.processPayment).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.processPayment).toHaveBeenCalledWith(
        'mock',
        160,
        'order-123',
      );
      expect(mockRepository.confirmOrder).toHaveBeenCalledWith(
        'order-123',
        { transactionId: 'mock_tx_123' },
        expect.objectContaining({ topic: 'order.created' }),
      );
    });

    it('closes a pending attempt whose payment row is gone', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder({ status: 'pending', payment_status: 'pending' }),
        items: [storedItem()],
      });
      mockRepository.findPendingPayment.mockResolvedValue(null);

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.getResponse()).toMatchObject({ code: 'ORDER_ATTEMPT_CLOSED' });
      expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
    });
  });

  describe('compensation', () => {
    it('releases the hold when the coupon is rejected', async () => {
      const dto = createSampleDto();
      dto.discountCode = 'INVALIDCODE';
      mockDiscountsService.validate.mockResolvedValueOnce({
        valid: false,
        message: 'Discount code has expired',
      });

      await expect(service.checkout(USER_ID, KEY, dto)).rejects.toThrow(
        UnprocessableEntityException,
      );

      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
      expect(mockPaymentsService.processPayment).not.toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith(LOCK_KEY);
    });

    it('closes the attempt as failed and releases the hold when the capture is declined on a resume', async () => {
      mockRepository.findByIdempotencyKey.mockResolvedValue({
        order: storedOrder({ status: 'pending', payment_status: 'pending' }),
        items: [storedItem()],
      });
      mockRepository.findPendingPayment.mockResolvedValue(pendingPayment());
      mockPaymentsService.processPayment.mockResolvedValueOnce({
        success: false,
        errorMessage: 'Declined by issuer',
      });

      const error = await rejection(service.checkout(USER_ID, KEY, createSampleDto()));

      expect(error.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(error.getResponse()).toMatchObject({ code: 'PAYMENT_FAILED' });
      expect(mockRepository.failOrder).toHaveBeenCalledWith(
        'order-123',
        expect.any(String),
        'failed',
      );
      expect(mockCatalogClient.releaseStock).toHaveBeenCalledTimes(1);
      expect(mockRedis.del).toHaveBeenCalledWith(LOCK_KEY);
    });

    it('maps a catalog contract failure to 502 and a dead catalog to 503', async () => {
      mockCatalogClient.reserveStock.mockResolvedValueOnce({
        ok: false,
        failure: 'invalid_request',
        message: '{qty} is not part of the contract',
      });
      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(BadGatewayException);

      mockCatalogClient.reserveStock.mockResolvedValueOnce({
        ok: false,
        failure: 'unavailable',
        message: 'Unable to reach catalog service',
      });
      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('does not release anything when the hold was never taken', async () => {
      mockCatalogClient.reserveStock.mockResolvedValueOnce({
        ok: false,
        failure: 'unavailable',
        message: 'Unable to reach catalog service',
      });

      await expect(
        service.checkout(USER_ID, KEY, createSampleDto()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(mockCatalogClient.releaseStock).not.toHaveBeenCalled();
    });
  });
});
