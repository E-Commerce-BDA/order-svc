import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrdersRepository, type OrderWithDetails } from './orders.repository.js';
import { RefundsRepository } from './refunds.repository.js';
import { assertValidTransition } from './order-state-machine.js';
import { CatalogClient } from '../clients/catalog.client.js';
import { PaymentsService } from '../payments/payments.service.js';
import type { PaymentResult } from '../payments/payment-provider.interface.js';
import type { OrderRow, OrderStatusHistoryRow, RefundRow } from '../db/rows.js';
import type {
  AdminOrderQueryDto,
  CustomerOrderQueryDto,
} from './dto/order-query.dto.js';
import type { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import type { RefundOrderDto } from './dto/refund-order.dto.js';

export interface UserContext {
  userId: string;
  roles: string[];
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly refundsRepository: RefundsRepository,
    private readonly catalogClient: CatalogClient,
    private readonly paymentsService: PaymentsService,
  ) {}

  /**
   * Retrieves customer order history with cursor pagination.
   */
  async findCustomerOrders(
    userId: string,
    query: CustomerOrderQueryDto,
  ): Promise<{ data: OrderWithDetails[]; nextCursor: string | null }> {
    return this.ordersRepository.findCustomerOrders(
      userId,
      query.cursor,
      query.limit,
    );
  }

  /**
   * Retrieves detailed order by ID with role-based access control.
   */
  async findOrderById(
    orderId: string,
    currentUser: UserContext,
  ): Promise<OrderWithDetails> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    const isAdmin = currentUser.roles?.includes('admin');
    if (!isAdmin && order.user_id !== currentUser.userId) {
      throw new ForbiddenException('You do not have access to this order');
    }

    return order;
  }

  /**
   * Admin order list with filtering, searching, and pagination.
   */
  async findAdminOrders(query: AdminOrderQueryDto): Promise<{
    data: OrderWithDetails[];
    total: number;
    page: number;
    perPage: number;
  }> {
    return this.ordersRepository.findAdminOrders(query);
  }

  /**
   * Admin status history timeline retrieval.
   */
  async findStatusHistory(orderId: string): Promise<OrderStatusHistoryRow[]> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    return this.ordersRepository.findStatusHistory(orderId);
  }

  /**
   * Admin order status update enforcing the finite state machine.
   *
   * A terminal state gives the stock back: the hold was taken for an order that
   * will never ship, and only the order row knows which hold it is.
   */
  async updateStatus(
    orderId: string,
    dto: UpdateOrderStatusDto,
    actor: string,
  ): Promise<OrderRow> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    assertValidTransition(order.status, dto.status);

    const updated = await this.ordersRepository.updateStatusWithHistory(
      orderId,
      order.status,
      dto.status,
      dto.note ?? null,
      actor,
    );

    // After the state change commits: a release that fails is a warning, because
    // the reservation expires on its own and the order is already correct.
    if (updated.status === 'cancelled' || updated.status === 'failed') {
      await this.releaseHold(updated.stock_reservation_id);
    }

    return updated;
  }

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

  /**
   * Admin refund. The provider is the one that actually returns the money, so the
   * ledger row is reserved first and settled only after the provider answers:
   * the books can never claim a refund that did not happen.
   */
  async refundOrder(
    orderId: string,
    dto: RefundOrderDto,
    actor: string,
  ): Promise<{ order: OrderRow; refund: RefundRow }> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    const existing = await this.refundsRepository.findByOrderId(orderId);

    // The ledger is the idempotency gate: a settled refund is returned as-is, so
    // replaying the call never moves money twice.
    if (existing?.status === 'succeeded') return { order, refund: existing };
    if (existing?.status === 'pending') throw refundInProgress(orderId);

    const grandTotalNum = parseFloat(order.grand_total);
    const requestedAmount = dto.amount ?? grandTotalNum;

    if (requestedAmount > grandTotalNum) {
      throw new BadRequestException(
        `Refund amount ($${requestedAmount.toFixed(2)}) exceeds order grand total ($${grandTotalNum.toFixed(2)})`,
      );
    }

    assertValidTransition(order.status, 'refunded');

    const payment = await this.refundsRepository.findCapturedPayment(orderId);
    if (!payment?.transaction_id) {
      throw new ConflictException({
        code: 'NO_CAPTURED_PAYMENT',
        message: `Order ${orderId} has no captured payment to refund`,
      });
    }

    let refund = existing;
    if (!refund) {
      const started = await this.refundsRepository.startRefund({
        orderId,
        paymentId: payment.id,
        amount: Math.round(requestedAmount * 100) / 100,
        reason: dto.reason ?? null,
        requestedBy: actor,
      });
      refund = started.refund;

      if (!started.created) {
        if (refund.status === 'succeeded') return { order, refund };
        if (refund.status === 'pending') throw refundInProgress(orderId);
      }
    }

    // A failed attempt is retried in place, with the amount it was reserved for,
    // so a provider outage cannot change what the customer gets back.
    const amount = Number(refund.amount);
    let result: PaymentResult;

    try {
      result = await this.paymentsService.processRefund(
        payment.transaction_id,
        amount,
        refund.reason ?? undefined,
      );
    } catch (error) {
      this.logger.error(
        `Refund of ${payment.transaction_id} threw`,
        error instanceof Error ? error.stack : error,
      );
      await this.refundsRepository.markFailed(refund.id, 'Payment provider unreachable');
      throw new BadGatewayException({
        code: 'REFUND_PROVIDER_FAILED',
        message: 'The payment provider could not be reached; retry the refund',
      });
    }

    if (!result.success) {
      const reason = result.errorMessage ?? 'The payment provider declined the refund';
      this.logger.warn(`Refund of ${payment.transaction_id} failed: ${reason}`);
      await this.refundsRepository.markFailed(refund.id, reason);
      throw new BadGatewayException({ code: 'REFUND_PROVIDER_FAILED', message: reason });
    }

    const providerReference = result.transactionId ?? `refund_${refund.id}`;
    return this.refundsRepository.markSucceeded(refund.id, providerReference);
  }
}

function refundInProgress(orderId: string): ConflictException {
  return new ConflictException({
    code: 'REFUND_IN_PROGRESS',
    message: `A refund for order ${orderId} is still being processed`,
  });
}
