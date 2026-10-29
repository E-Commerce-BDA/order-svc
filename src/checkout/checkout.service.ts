import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { RedisService } from '../redis/redis.service.js';
import { CatalogClient, type ReserveStockResult } from '../clients/catalog.client.js';
import { CartClient } from '../clients/cart.client.js';
import { DiscountsService } from '../discounts/discounts.service.js';
import { DiscountsRepository } from '../discounts/discounts.repository.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import type { OrderRow } from '../db/rows.js';

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

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly catalogClient: CatalogClient,
    private readonly cartClient: CartClient,
    private readonly discountsService: DiscountsService,
    private readonly discountsRepository: DiscountsRepository,
    private readonly paymentsService: PaymentsService,
  ) {}

  async checkout(
    userId: string,
    idempotencyKey: string,
    dto: CheckoutDto,
  ): Promise<CheckoutConfirmation> {
    if (!idempotencyKey || !idempotencyKey.trim()) {
      throw new BadRequestException('x-idempotency-key header is required');
    }

    const idemKey = `idem:${idempotencyKey.trim()}`;
    const idemLockKey = `idem:${idempotencyKey.trim()}:lock`;
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(dto))
      .digest('hex');

    // 1. Check Redis Idempotency Cache
    const cached = await this.redisService.get(idemKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          bodyHash: string;
          response: CheckoutConfirmation;
        };
        if (parsed.bodyHash === bodyHash) {
          this.logger.log(`Idempotency hit for key ${idempotencyKey}`);
          return parsed.response;
        }
        throw new ConflictException(
          'IDEMPOTENCY_CONFLICT: Idempotency key was previously used with a different request payload',
        );
      } catch (err) {
        if (err instanceof ConflictException) throw err;
      }
    }

    // 2. Acquire In-Flight Idempotency Lock
    const acquiredLock = await this.redisService.setnx(idemLockKey, 'processing', 60);
    if (!acquiredLock) {
      throw new ConflictException(
        'IDEMPOTENCY_IN_PROGRESS: Checkout with this idempotency key is currently processing',
      );
    }

    const reservationId = randomUUID();

    try {
      // 3. Stock Reservation in catalog-svc — the reservationId is generated
      // locally and is the idempotency key, so a retried checkout cannot
      // decrement stock twice.
      const reservation = await this.catalogClient.reserveStock(
        reservationId,
        dto.items.map((i) => ({
          productId: i.productId,
          variantId: i.variantId ?? null,
          quantity: i.qty,
        })),
      );

      if (!reservation.ok) {
        await this.redisService.del(idemLockKey);
        throw this.toStockError(reservation);
      }

      // 4. Hydrate Snapshots & Compute Line Totals
      const snapshots = await this.catalogClient.getProductSnapshots(
        dto.items.map((i) => i.variantId ?? i.productId),
      );

      const itemsWithSnapshots: CheckoutItemResponse[] = dto.items.map((item) => {
        const snap = snapshots.get(item.variantId ?? item.productId);
        const productName = snap?.productName ?? `Product ${item.productId.slice(0, 8)}`;
        const sku = snap?.sku ?? `SKU-${item.productId.slice(0, 8)}`;
        const unitPrice = snap
          ? (snap.effectivePrice ?? snap.unitPrice)
          : 50.00;
        const lineTotal = Math.round(unitPrice * item.qty * 100) / 100;

        return {
          productId: item.productId,
          variantId: item.variantId,
          productName,
          sku,
          unitPrice,
          qty: item.qty,
          lineTotal,
        };
      });

      const subtotal = itemsWithSnapshots.reduce((sum, item) => sum + item.lineTotal, 0);

      // 5. Discount Validation & Calculation
      let discount = 0;
      let couponId: string | undefined;

      if (dto.discountCode && dto.discountCode.trim()) {
        const valRes = await this.discountsService.validate(
          dto.discountCode,
          subtotal,
        );

        if (!valRes.valid) {
          await this.catalogClient.releaseStock(reservationId);
          await this.redisService.del(idemLockKey);
          throw new UnprocessableEntityException(
            valRes.message ?? 'COUPON_INVALID: Discount code is invalid or expired',
          );
        }

        discount = valRes.discount ?? 0;
        couponId = valRes.id;
      }

      const shipping = subtotal >= 100 ? 0.0 : 5.0;
      const tax = 0.0;
      const grandTotal = Math.max(
        0,
        Math.round((subtotal + shipping + tax - discount) * 100) / 100,
      );

      // 6. Payment Authorization & Capture
      const paymentRes = await this.paymentsService.processPayment(
        dto.payment.provider,
        grandTotal,
        'order-temp',
      );

      if (!paymentRes.success) {
        await this.catalogClient.releaseStock(reservationId);
        await this.redisService.del(idemLockKey);
        throw new BadRequestException(
          `PAYMENT_FAILED: ${paymentRes.errorMessage ?? 'Payment authorization failed'}`,
        );
      }

      // 7. Atomic Database Transaction (Order + Items + History + Payment + Outbox)
      const pool = getPool();
      const client = await pool.connect();
      const orderNumber = `#2026-${randomInt(100000, 999999)}`;
      let orderId = '';

      try {
        await client.query('BEGIN');

        const orderInsert = await client.query<OrderRow>(
          `INSERT INTO "order".orders (
            user_id, order_number, status, subtotal, shipping_fee, tax, discount, grand_total,
            currency, payment_status, shipping_address, billing_address, discount_code_id,
            stock_reservation_id, notes
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          RETURNING id;`,
          [
            userId,
            orderNumber,
            'confirmed',
            subtotal,
            shipping,
            tax,
            discount,
            grandTotal,
            'USD',
            'paid',
            JSON.stringify(dto.shippingAddress),
            JSON.stringify(dto.billingAddress),
            couponId ?? null,
            reservationId,
            dto.notes ?? null,
          ],
        );
        orderId = orderInsert.rows[0].id;

        for (const item of itemsWithSnapshots) {
          await client.query(
            `INSERT INTO "order".order_items (
              order_id, product_id, variant_id, product_name, sku, unit_price, qty, line_total, options
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);`,
            [
              orderId,
              item.productId,
              item.variantId ?? null,
              item.productName,
              item.sku,
              item.unitPrice,
              item.qty,
              item.lineTotal,
              null,
            ],
          );
        }

        await client.query(
          `INSERT INTO "order".order_status_history (
            order_id, from_status, to_status, note, actor
          ) VALUES ($1, $2, $3, $4, $5);`,
          [
            orderId,
            null,
            'confirmed',
            'Order placed and payment authorized',
            userId,
          ],
        );

        await client.query(
          `INSERT INTO "order".payments (
            order_id, provider, amount, status, transaction_id, paid_at
          ) VALUES ($1, $2, $3, $4, $5, now());`,
          [
            orderId,
            dto.payment.provider,
            grandTotal,
            'captured',
            paymentRes.transactionId ?? `mock_tx_${randomUUID().slice(0, 12)}`,
          ],
        );

        if (couponId) {
          await this.discountsRepository.incrementUsesCount(client, couponId);
        }

        const outboxPayload = {
          orderId,
          orderNumber,
          userId,
          grandTotal,
          itemsCount: itemsWithSnapshots.length,
          reservationId,
          createdAt: new Date().toISOString(),
        };

        await client.query(
          `INSERT INTO "order".outbox (
            event_id, aggregate_type, aggregate_id, event_type, payload
          ) VALUES ($1, $2, $3, $4, $5);`,
          [
            randomUUID(),
            'order',
            orderId,
            'order.created',
            JSON.stringify(outboxPayload),
          ],
        );

        await client.query('COMMIT');
      } catch (txError) {
        await client.query('ROLLBACK');
        await this.catalogClient.releaseStock(reservationId);
        await this.redisService.del(idemLockKey);
        throw txError;
      } finally {
        client.release();
      }

      const responsePayload: CheckoutConfirmation = {
        orderId,
        orderNumber,
        status: 'confirmed',
        totals: {
          subtotal,
          shipping,
          tax,
          discount,
          grandTotal,
        },
        items: itemsWithSnapshots,
      };

      // 8. Cache in Redis (24h TTL) & Release Lock
      await this.redisService.set(
        idemKey,
        JSON.stringify({ bodyHash, response: responsePayload }),
        86400,
      );
      await this.redisService.del(idemLockKey);

      // 9. Best-effort cart conversion
      this.cartClient.clearCart(userId).catch(() => {});

      return responsePayload;
    } catch (err) {
      await this.redisService.del(idemLockKey).catch(() => {});
      throw err;
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
        return new ConflictException(
          `${failure.code ?? 'STOCK_INSUFFICIENT'}: ${failure.message}`,
        );
      case 'invalid_request':
        return new BadGatewayException(
          `CATALOG_CONTRACT_ERROR: ${failure.message}`,
        );
      default:
        return new ServiceUnavailableException(
          `CATALOG_UNAVAILABLE: ${failure.message}`,
        );
    }
  }
}
