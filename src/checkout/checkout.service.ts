import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
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
import type { PaymentResult } from '../payments/payment-provider.interface.js';
import {
  CheckoutRepository,
  DuplicateIdempotencyKeyError,
  type OutboxWrite,
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

/**
 * Where the saga currently stands, so a failure knows exactly what to undo.
 *
 * pricing   → nothing durable exists (only the stock hold)
 * persisting→ TX1 was attempted
 * persisted → the order row exists as `pending`, no money has moved
 * captured  → the provider took the money, TX2 has not committed
 */
type SagaPhase = 'pricing' | 'persisting' | 'persisted' | 'captured';

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
        // We lost the insert race and our hold is already released: nothing was
        // captured, because the capture can no longer precede the insert. The
        // customer's order is the winner's, whose own saga may still be pending.
        const winner = await this.checkoutRepository.findByIdempotencyKey(userId, key);
        if (!winner) throw error;
        this.logger.warn(
          `Lost the idempotency race for ${cacheKey}; serving order ${winner.order.id}`,
        );
        confirmation = await this.replayStoredAttempt(winner.order, winner.items, bodyHash);
      }

      await this.cacheResponse(cacheKey, bodyHash, confirmation);
      // Phase-0 bridge until ca-009; must never fail the confirmation.
      this.cartClient.convertCart(userId).catch(() => {});

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
    // Generated locally and stored on the order, so a compensation can release
    // exactly this hold and nothing else.
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

    let phase: SagaPhase = 'pricing';
    let orderId: string | null = null;
    let transactionId: string | null = null;
    let grandTotal = 0;

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

      // TX1 — the first durable write. It must not exist without a hold, and it
      // must exist before any money moves.
      phase = 'persisting';
      const pending = await this.checkoutRepository.createOrder({
        userId,
        status: 'pending',
        paymentStatus: 'pending',
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
        historyNote: 'Order placed, awaiting payment',
        actor: userId,
        payment: {
          provider: dto.payment.provider,
          amount: grandTotal,
          status: 'pending',
          transactionId: null,
        },
        outbox: null,
      });
      orderId = pending.orderId;
      phase = 'persisted';

      const capture = await this.capture(orderId, dto.payment.provider, grandTotal);
      transactionId = capture.transactionId;
      phase = 'captured';

      // TX2 — only now may the order exist as anything other than pending.
      await this.checkoutRepository.confirmOrder(
        orderId,
        { transactionId },
        this.orderCreatedEvent({ userId, grandTotal, itemsCount: items.length, reservationId }),
      );

      return {
        orderId,
        orderNumber: pending.orderNumber,
        status: 'confirmed',
        totals: { subtotal, shipping, tax, discount, grandTotal },
        items,
      };
    } catch (error) {
      throw await this.recover({
        error,
        phase,
        orderId,
        grandTotal,
        transactionId,
        reservationId,
      });
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
   * Capture against the persisted order, so the provider's idempotency key is the
   * order id and a resumed attempt re-charges nothing.
   *
   * A decline is an answer (402, the attempt is over); a thrown error is not (503,
   * the attempt stays `pending` and the customer may retry the same key).
   */
  private async capture(
    orderId: string,
    provider: 'mock' | 'stripe' | 'paypal',
    amount: number,
  ): Promise<{ transactionId: string }> {
    let payment: PaymentResult;

    try {
      payment = await this.paymentsService.processPayment(provider, amount, orderId);
    } catch (error) {
      this.logger.error(
        `Payment provider threw while capturing order ${orderId}`,
        error instanceof Error ? error.stack : error,
      );
      throw new ServiceUnavailableException({
        code: 'PAYMENT_UNAVAILABLE',
        message: 'Payment provider is unavailable; retry with the same key',
      });
    }

    if (!payment.success) {
      this.logger.warn(
        `Payment declined for order ${orderId}: ${payment.errorMessage ?? 'no reason given'}`,
      );
      throw new HttpException(
        {
          code: 'PAYMENT_FAILED',
          message: payment.errorMessage ?? 'Payment authorization failed',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return {
      transactionId: payment.transactionId ?? `mock_tx_${randomUUID().slice(0, 12)}`,
    };
  }

  /**
   * The failure matrix, in one place: what to undo depends only on how far the
   * saga got. Each branch returns the error the caller should raise, and no
   * compensation step may throw over the original failure.
   */
  private async recover(state: {
    error: unknown;
    phase: SagaPhase;
    orderId: string | null;
    grandTotal: number;
    transactionId: string | null;
    reservationId: string;
  }): Promise<unknown> {
    const { error, phase, orderId, grandTotal, transactionId, reservationId } = state;

    if (phase === 'pricing') {
      // Nothing durable exists; the original status (409/502/503/422) stands.
      await this.releaseHold(reservationId);
      return error;
    }

    if (phase === 'persisting') {
      await this.releaseHold(reservationId);

      // Someone else owns the key: let checkout() serve the winner.
      if (error instanceof DuplicateIdempotencyKeyError) return error;

      this.logger.error(
        `Order for hold ${reservationId} could not be written`,
        error instanceof Error ? error.stack : error,
      );
      return new ServiceUnavailableException({
        code: 'CHECKOUT_UNAVAILABLE',
        message: 'Checkout could not be persisted; retry with the same key',
      });
    }

    const settledOrderId = orderId as string;

    if (phase === 'persisted') {
      if (this.isDecline(error)) {
        await this.closeAttempt(settledOrderId, 'Payment declined', 'failed');
        await this.releaseHold(reservationId);
      } else {
        // Transient: keep the pending row *and* its hold, so the retry resumes the
        // same hold instead of confirming an order whose stock was released.
        this.logger.warn(
          `Order ${settledOrderId} stays pending after an unsettled capture; the retry resumes it`,
        );
      }
      return error;
    }

    // The money moved and TX2 did not commit: refund, then close what is left.
    return this.rollBackCapture(
      settledOrderId,
      transactionId as string,
      grandTotal,
      reservationId,
    );
  }

  /**
   * A `pending` row means an earlier attempt wrote the order and died before the
   * money settled. The retry finishes that saga: same order, same hold, same
   * provider idempotency key — never a second reservation or a second order.
   */
  private async resumeSaga(
    order: OrderRow,
    items: OrderItemRow[],
  ): Promise<CheckoutConfirmation> {
    const payment = await this.checkoutRepository.findPendingPayment(order.id);

    if (!payment) {
      throw new ConflictException({
        code: 'ORDER_ATTEMPT_CLOSED',
        message: `Order ${order.order_number} has no payment left to capture; start a new checkout with a new key`,
      });
    }

    const grandTotal = Number(order.grand_total);
    let transactionId: string;

    try {
      ({ transactionId } = await this.capture(order.id, payment.provider, grandTotal));
    } catch (error) {
      if (this.isDecline(error)) {
        await this.closeAttempt(order.id, 'Payment declined on retry', 'failed');
        await this.releaseHold(order.stock_reservation_id);
      }
      throw error;
    }

    try {
      await this.checkoutRepository.confirmOrder(
        order.id,
        { transactionId },
        this.orderCreatedEvent({
          userId: order.user_id,
          grandTotal,
          itemsCount: items.length,
          reservationId: order.stock_reservation_id ?? '',
        }),
      );
    } catch (error) {
      this.logger.error(
        `Resumed order ${order.id} could not be confirmed`,
        error instanceof Error ? error.stack : error,
      );
      throw await this.rollBackCapture(
        order.id,
        transactionId,
        grandTotal,
        order.stock_reservation_id,
      );
    }

    this.logger.log(`Resumed and confirmed pending order ${order.id}`);
    return this.toConfirmation({ ...order, status: 'confirmed' }, items);
  }

  /**
   * Money is captured but the order is not confirmed: refund it, record why, and
   * release the hold. Failure to refund is loud but never hides the original
   * failure — the customer must not be told to retry while the money is taken.
   */
  private async rollBackCapture(
    orderId: string,
    transactionId: string,
    amount: number,
    reservationId: string | null,
  ): Promise<ServiceUnavailableException> {
    const refunded = await this.refundQuietly(
      transactionId,
      amount,
      'order could not be confirmed',
    );

    await this.closeAttempt(
      orderId,
      refunded
        ? 'Payment captured but the order could not be confirmed; refunded'
        : 'Payment captured but the order could not be confirmed; refund failed',
      refunded ? 'refunded' : 'failed',
    );
    await this.releaseHold(reservationId);

    return new ServiceUnavailableException({
      code: 'PAYMENT_PERSIST_FAILED',
      message: refunded
        ? 'The payment was taken but the order could not be confirmed; it has been refunded'
        : 'The payment was taken but the order could not be confirmed; support will refund it',
    });
  }

  private async closeAttempt(
    orderId: string,
    note: string,
    paymentStatus: 'failed' | 'refunded',
  ): Promise<void> {
    try {
      const closed = await this.checkoutRepository.failOrder(orderId, note, paymentStatus);
      if (!closed) {
        this.logger.warn(`Order ${orderId} was already settled; nothing to close`);
      }
    } catch (error) {
      this.logger.error(
        `Unable to close order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Catalog releases are idempotent server-side, so one attempt at each call site
   * is enough; a failed release is a warning because the hold expires anyway.
   */
  private async releaseHold(reservationId: string | null): Promise<void> {
    if (!reservationId) return;

    try {
      const released = await this.catalogClient.releaseStock(reservationId);
      if (!released.ok) {
        this.logger.warn(
          `Release of hold ${reservationId} failed (${released.message}); the hold will expire`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Release of hold ${reservationId} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async refundQuietly(
    transactionId: string,
    amount: number,
    reason: string,
  ): Promise<boolean> {
    try {
      const refund = await this.paymentsService.processRefund(transactionId, amount, reason);
      if (!refund.success) {
        this.logger.error(
          `Refund of ${transactionId} was declined: ${refund.errorMessage ?? 'unknown reason'}; the money is captured`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        `Refund of ${transactionId} failed; the money is captured`,
        error instanceof Error ? error.stack : error,
      );
      return false;
    }
  }

  private orderCreatedEvent(context: {
    userId: string;
    grandTotal: number;
    itemsCount: number;
    reservationId: string;
  }): OutboxWrite {
    return {
      eventType: 'order.created',
      payload: ({ orderId, orderNumber }) => ({
        orderId,
        orderNumber,
        userId: context.userId,
        grandTotal: context.grandTotal,
        itemsCount: context.itemsCount,
        reservationId: context.reservationId,
        createdAt: new Date().toISOString(),
      }),
    };
  }

  /** 402 only comes from `capture`, and it always means "this attempt is over". */
  private isDecline(error: unknown): boolean {
    return error instanceof HttpException && error.getStatus() === HttpStatus.PAYMENT_REQUIRED;
  }

  /**
   * Same key, different body → conflict; a closed attempt → the key is burned; a
   * pending attempt → finish its saga instead of refusing the customer's retry.
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

    if (order.status === 'pending') return this.resumeSaga(order, items);

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
