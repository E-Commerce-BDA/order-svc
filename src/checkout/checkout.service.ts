import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../common/canonical-json.js';
import { RedisService } from '../redis/redis.service.js';
import { CatalogClient, type ReserveStockResult } from '../clients/catalog.client.js';
import { CartClient } from '../clients/cart.client.js';
import { DiscountsService } from '../discounts/discounts.service.js';
import { PaymentsService } from '../payments/payments.service.js';
import {
  CheckoutRepository,
  DuplicateIdempotencyKeyError,
} from './checkout.repository.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import type { OrderItemRow, OrderRow } from '../db/rows.js';

/** The route segment is part of the key: one key space per endpoint. */
const IDEMPOTENCY_ROUTE = 'checkout';
const CACHE_TTL_SECONDS = 86_400;
const LOCK_TTL_SECONDS = 60;

export interface CheckoutTotals {
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  grandTotal: number;
}

export interface CheckoutItemResponse {
  productId: string;
  variantId?: string;
  productName: string;
  sku: string;
  unitPrice: number;
  qty: number;
  lineTotal: number;
}

export interface CheckoutConfirmation {
  orderId: string;
  orderNumber: string;
  status: string;
  totals: CheckoutTotals;
  items: CheckoutItemResponse[];
}

interface CachedResponse {
  bodyHash: string;
  response: CheckoutConfirmation;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly catalogClient: CatalogClient,
    private readonly cartClient: CartClient,
    private readonly discountsService: DiscountsService,
    private readonly paymentsService: PaymentsService,
    private readonly checkoutRepository: CheckoutRepository,
  ) {}

  /**
   * Guard order matters: hash → replay cache → lock → database → write.
   *
   * Redis is never the authority. A cached response is only replayed when the
   * order row it names still exists, and any Redis failure *before* the first
   * durable write fails closed with a retryable 503 — while a failure *after*
   * the commit only costs us the cache entry, never the order.
   */
  async checkout(
    userId: string,
    idempotencyKey: string,
    dto: CheckoutDto,
  ): Promise<CheckoutConfirmation> {
    const key = idempotencyKey?.trim() ?? '';
    if (!key) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'x-idempotency-key header is required',
      });
    }

    const cacheKey = `idem:${userId}:${IDEMPOTENCY_ROUTE}:${key}`;
    const lockKey = `${cacheKey}:lock`;
    const bodyHash = createHash('sha256').update(canonicalJson(dto)).digest('hex');

    const cached = await this.readCachedResponse(cacheKey);
    if (cached) {
      if (cached.bodyHash !== bodyHash) throw idempotencyConflict();
      // A cache entry is a claim, not proof: confirm the order it names exists.
      const stored = await this.checkoutRepository.findByIdempotencyKey(userId, key);
      if (stored && stored.order.id === cached.response.orderId) {
        this.logger.log(`Idempotency replay from cache for ${cacheKey}`);
        return cached.response;
      }
      this.logger.warn(
        `Cached response for ${cacheKey} has no matching order row; deriving it from the database`,
      );
    }

    await this.acquireLock(lockKey);

    try {
      const stored = await this.checkoutRepository.findByIdempotencyKey(userId, key);
      if (stored) {
        const replay = await this.replayStoredAttempt(stored.order, stored.items, bodyHash);
        await this.cacheResponse(cacheKey, bodyHash, replay);
        return replay;
      }

      let confirmation: CheckoutConfirmation;
      try {
        confirmation = await this.placeOrder(userId, key, bodyHash, dto);
      } catch (error) {
        if (!(error instanceof DuplicateIdempotencyKeyError)) throw error;
        // We lost the insert race. Our own capture and hold were compensated in
        // placeOrder; the customer's order is the winner's.
        const winner = await this.checkoutRepository.findByIdempotencyKey(userId, key);
        if (!winner) throw error;
        this.logger.warn(
          `Lost the idempotency race for ${cacheKey}; serving order ${winner.order.id}`,
        );
        confirmation = this.toConfirmation(winner.order, winner.items);
      }

      await this.cacheResponse(cacheKey, bodyHash, confirmation);
      this.cartClient.clearCart(userId).catch(() => {});

      return confirmation;
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  /**
   * Reserve → price → capture → persist, with every post-hold failure releasing
   * the hold exactly once.
   */
  private async placeOrder(
    userId: string,
    idempotencyKey: string,
    bodyHash: string,
    dto: CheckoutDto,
  ): Promise<CheckoutConfirmation> {
    // Generated locally and reused as the provider idempotency key, so a retried
    // capture cannot charge twice.
    const reservationId = randomUUID();

    const reservation = await this.catalogClient.reserveStock(
      reservationId,
      dto.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: item.qty,
      })),
    );

    if (!reservation.ok) throw this.toStockError(reservation);

    let grandTotal = 0;
    let capture: { transactionId: string } | null = null;

    try {
      const items = await this.priceLines(dto);
      const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);

      let discount = 0;
      let couponId: string | null = null;

      if (dto.discountCode?.trim()) {
        const validated = await this.discountsService.validate(dto.discountCode, subtotal);

        if (!validated.valid) {
          throw new UnprocessableEntityException({
            code: 'COUPON_INVALID',
            message: validated.message ?? 'Discount code is invalid or expired',
          });
        }

        discount = validated.discount ?? 0;
        couponId = validated.id ?? null;
      }

      const shipping = subtotal >= 100 ? 0 : 5;
      const tax = 0;
      grandTotal = Math.max(
        0,
        Math.round((subtotal + shipping + tax - discount) * 100) / 100,
      );

      const payment = await this.paymentsService.processPayment(
        dto.payment.provider,
        grandTotal,
        reservationId,
      );

      if (!payment.success) {
        throw new BadRequestException({
          code: 'PAYMENT_FAILED',
          message: payment.errorMessage ?? 'Payment authorization failed',
        });
      }

      const transactionId = payment.transactionId ?? `mock_tx_${randomUUID().slice(0, 12)}`;
      capture = { transactionId };

      const persisted = await this.checkoutRepository.createOrder({
        userId,
        status: 'confirmed',
        paymentStatus: 'paid',
        subtotal,
        shipping,
        tax,
        discount,
        grandTotal,
        currency: 'USD',
        shippingAddress: dto.shippingAddress,
        billingAddress: dto.billingAddress,
        discountCodeId: couponId,
        stockReservationId: reservationId,
        idempotencyKey,
        idempotencyBodyHash: bodyHash,
        notes: dto.notes ?? null,
        items,
        historyNote: 'Order placed and payment authorized',
        actor: userId,
        payment: {
          provider: dto.payment.provider,
          amount: grandTotal,
          status: 'captured',
          transactionId,
        },
        outbox: {
          eventType: 'order.created',
          payload: ({ orderId, orderNumber }) => ({
            orderId,
            orderNumber,
            userId,
            grandTotal,
            itemsCount: items.length,
            reservationId,
            createdAt: new Date().toISOString(),
          }),
        },
      });

      return {
        orderId: persisted.orderId,
        orderNumber: persisted.orderNumber,
        status: 'confirmed',
        totals: { subtotal, shipping, tax, discount, grandTotal },
        items,
      };
    } catch (error) {
      await this.compensate(reservationId, capture, grandTotal, error);
      throw error;
    }
  }

  private async priceLines(dto: CheckoutDto): Promise<CheckoutItemResponse[]> {
    const snapshots = await this.catalogClient.getProductSnapshots(
      dto.items.map((item) => item.variantId ?? item.productId),
    );

    return dto.items.map((item) => {
      const snapshot = snapshots.get(item.variantId ?? item.productId);
      const unitPrice = snapshot
        ? (snapshot.effectivePrice ?? snapshot.unitPrice)
        : 50.0;

      return {
        productId: item.productId,
        variantId: item.variantId,
        productName: snapshot?.productName ?? `Product ${item.productId.slice(0, 8)}`,
        sku: snapshot?.sku ?? `SKU-${item.productId.slice(0, 8)}`,
        unitPrice,
        qty: item.qty,
        lineTotal: Math.round(unitPrice * item.qty * 100) / 100,
      };
    });
  }

  /**
   * Undo what this attempt did, once. The hold is released for free (catalog is
   * idempotent and the hold expires on its own); a capture is money, so it is
   * refunded — losing the idempotency race must not charge a customer for an
   * order we did not write.
   */
  private async compensate(
    reservationId: string,
    capture: { transactionId: string } | null,
    amount: number,
    error: unknown,
  ): Promise<void> {
    if (capture) {
      const refund = await this.paymentsService
        .processRefund(capture.transactionId, amount, 'checkout did not persist an order')
        .catch((refundError: unknown) => {
          this.logger.error(
            `Refund of ${capture.transactionId} failed; money is captured without an order`,
            refundError instanceof Error ? refundError.stack : refundError,
          );
          return null;
        });

      if (refund && !refund.success) {
        this.logger.error(
          `Refund of ${capture.transactionId} was declined: ${refund.errorMessage ?? 'unknown'}`,
        );
      }
    }

    const released = await this.catalogClient.releaseStock(reservationId);
    if (!released.ok) {
      this.logger.warn(
        `Release of hold ${reservationId} failed (${released.message}); the hold will expire`,
      );
    }

    if (error instanceof DuplicateIdempotencyKeyError) {
      this.logger.warn(
        `Compensated the losing attempt for hold ${reservationId} after an idempotency-key race`,
      );
    }
  }

  /**
   * Same key, different body → conflict; a closed attempt → the key is burned; a
   * pending attempt is still in flight from the customer's point of view.
   */
  private async replayStoredAttempt(
    order: OrderRow,
    items: OrderItemRow[],
    bodyHash: string,
  ): Promise<CheckoutConfirmation> {
    if (order.idempotency_body_hash !== bodyHash) throw idempotencyConflict();

    if (order.status === 'failed' || order.status === 'cancelled') {
      throw new ConflictException({
        code: 'ORDER_ATTEMPT_CLOSED',
        message: `The attempt using this key ended as ${order.status}; start a new checkout with a new key`,
      });
    }

    if (order.status === 'pending') {
      // ord-009 resumes the saga here instead of refusing the retry.
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Checkout with this idempotency key is still being settled',
      });
    }

    this.logger.log(`Idempotency replay from the database for order ${order.id}`);
    return this.toConfirmation(order, items);
  }

  private toConfirmation(
    order: OrderRow,
    items: OrderItemRow[],
  ): CheckoutConfirmation {
    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: order.status,
      totals: {
        subtotal: Number(order.subtotal),
        shipping: Number(order.shipping_fee),
        tax: Number(order.tax),
        discount: Number(order.discount),
        grandTotal: Number(order.grand_total),
      },
      items: items.map((item) => ({
        productId: item.product_id,
        variantId: item.variant_id ?? undefined,
        productName: item.product_name,
        sku: item.sku,
        unitPrice: Number(item.unit_price),
        qty: item.qty,
        lineTotal: Number(item.line_total),
      })),
    };
  }

  /**
   * A corrupt entry is a miss, never a crash and never a silent pass-through: it
   * is logged so a bad writer shows up, and the database decides what happened.
   */
  private async readCachedResponse(cacheKey: string): Promise<CachedResponse | null> {
    let raw: string | null;

    try {
      raw = await this.redisService.get(cacheKey);
    } catch (error) {
      this.logger.error(
        `Idempotency cache unavailable for ${cacheKey}`,
        error instanceof Error ? error.stack : error,
      );
      throw new ServiceUnavailableException({
        code: 'IDEMPOTENCY_UNAVAILABLE',
        message: 'Idempotency store is unavailable; retry with the same key',
      });
    }

    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<CachedResponse>;
      if (typeof parsed.bodyHash !== 'string' || !parsed.response) {
        this.logger.error(`Idempotency cache entry ${cacheKey} is incomplete; treating it as a miss`);
        return null;
      }
      return { bodyHash: parsed.bodyHash, response: parsed.response };
    } catch (error) {
      this.logger.error(
        `Idempotency cache entry ${cacheKey} is not valid JSON; treating it as a miss`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  /**
   * The lock only serialises concurrent attempts; it is not the dedupe itself,
   * which is the unique index. An unreachable Redis means we cannot tell whether
   * another attempt is running, so we refuse rather than risk a second order.
   */
  private async acquireLock(lockKey: string): Promise<void> {
    let acquired: boolean;

    try {
      acquired = await this.redisService.setnx(lockKey, 'processing', LOCK_TTL_SECONDS);
    } catch (error) {
      this.logger.error(
        `Unable to acquire ${lockKey}`,
        error instanceof Error ? error.stack : error,
      );
      throw new ServiceUnavailableException({
        code: 'IDEMPOTENCY_UNAVAILABLE',
        message: 'Idempotency store is unavailable; retry with the same key',
      });
    }

    if (!acquired) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'Checkout with this idempotency key is currently processing',
      });
    }
  }

  private async releaseLock(lockKey: string): Promise<void> {
    await this.redisService.del(lockKey).catch((error: unknown) => {
      this.logger.warn(
        `Unable to release ${lockKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * Post-commit cache write. The order is already durable, so a failure here is
   * a warning: the customer's retry replays from the database.
   */
  private async cacheResponse(
    cacheKey: string,
    bodyHash: string,
    response: CheckoutConfirmation,
  ): Promise<void> {
    try {
      await this.redisService.set(
        cacheKey,
        JSON.stringify({ bodyHash, response } satisfies CachedResponse),
        CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Order ${response.orderId} is committed but not cached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A stock failure is not always a 409: a contract drift must surface as a bad
   * gateway (our client is wrong) and a dead catalog as unavailable, so the
   * storefront can retry instead of telling the customer the item is gone.
   */
  private toStockError(
    failure: Extract<ReserveStockResult, { ok: false }>,
  ): ConflictException | BadGatewayException | ServiceUnavailableException {
    switch (failure.failure) {
      case 'insufficient_stock':
        return new ConflictException({
          code: failure.code ?? 'STOCK_INSUFFICIENT',
          message: failure.message,
        });
      case 'invalid_request':
        return new BadGatewayException({
          code: 'CATALOG_CONTRACT_ERROR',
          message: failure.message,
        });
      default:
        return new ServiceUnavailableException({
          code: 'CATALOG_UNAVAILABLE',
          message: failure.message,
        });
    }
  }
}

function idempotencyConflict(): ConflictException {
  return new ConflictException({
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'x-idempotency-key was already used with a different request payload',
  });
}
