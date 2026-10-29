import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrdersRepository, type OrderWithDetails } from './orders.repository.js';
import { assertValidTransition } from './order-state-machine.js';
import { CatalogClient } from '../clients/catalog.client.js';
import type { OrderRow, OrderStatusHistoryRow } from '../db/rows.js';
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
    private readonly catalogClient: CatalogClient,
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
   * Admin order refund processing with amount validation and state transition.
   */
  async refundOrder(
    orderId: string,
    dto: RefundOrderDto,
    actor: string,
  ): Promise<OrderRow> {
    const order = await this.ordersRepository.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    assertValidTransition(order.status, 'refunded');

    const grandTotalNum = parseFloat(order.grand_total);
    const refundAmountNum = dto.amount ?? grandTotalNum;

    if (refundAmountNum > grandTotalNum) {
      throw new BadRequestException(
        `Refund amount ($${refundAmountNum.toFixed(2)}) exceeds order grand total ($${grandTotalNum.toFixed(2)})`,
      );
    }

    const refundAmountStr = refundAmountNum.toFixed(2);
    return this.ordersRepository.refundOrderWithHistory(
      orderId,
      order.status,
      refundAmountStr,
      dto.reason ?? null,
      actor,
    );
  }
}
