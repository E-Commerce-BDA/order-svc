import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import {
  AdminOrderQueryDto,
  CustomerOrderQueryDto,
} from './dto/order-query.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { RefundOrderDto } from './dto/refund-order.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { OrderRow, OrderStatusHistoryRow } from '../db/rows.js';
import type { OrderWithDetails } from './orders.repository.js';

@Controller(['me/orders', 'order/me/orders', 'orders/me'])
export class CustomerOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * Customer order history list with cursor-based pagination.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  async getMyOrders(
    @Req() req: AuthenticatedRequest,
    @Query() query: CustomerOrderQueryDto,
  ): Promise<{ data: OrderWithDetails[]; nextCursor: string | null }> {
    const userId = req.user?.sub ?? '018f0000-0000-7000-8000-000000000001';
    return this.ordersService.findCustomerOrders(userId, query);
  }
}

@Controller(['order/orders', 'orders'])
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * Admin: List all orders with filters, search, and offset pagination.
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async findAll(@Query() query: AdminOrderQueryDto): Promise<{
    data: OrderWithDetails[];
    total: number;
    page: number;
    perPage: number;
  }> {
    return this.ordersService.findAdminOrders(query);
  }

  /**
   * Order details by ID (accessible by customer owner or admin).
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findById(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ order: OrderWithDetails }> {
    const userId = req.user?.sub ?? '';
    const roles = req.user?.roles ?? [];
    const order = await this.ordersService.findOrderById(id, { userId, roles });
    return { order };
  }

  /**
   * Admin: Order status history timeline.
   */
  @Get(':id/status-history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async findStatusHistory(
    @Param('id') id: string,
  ): Promise<{ history: OrderStatusHistoryRow[] }> {
    const history = await this.ordersService.findStatusHistory(id);
    return { history };
  }

  /**
   * Admin: Update order status adhering to the finite state machine.
   */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async updateStatus(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ): Promise<{ order: OrderRow }> {
    const actor = req.user?.sub ?? 'admin';
    const order = await this.ordersService.updateStatus(id, dto, actor);
    return { order };
  }

  /**
   * Admin: Process order refund.
   */
  @Post(':id/refund')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async refundOrder(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RefundOrderDto,
  ): Promise<{ order: OrderRow }> {
    const actor = req.user?.sub ?? 'admin';
    const order = await this.ordersService.refundOrder(id, dto, actor);
    return { order };
  }
}
