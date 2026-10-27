import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ServiceKeyGuard } from '../common/guards/service-key.guard.js';
import { OrdersService } from '../orders/orders.service.js';
import type { OrderWithDetails } from '../orders/orders.repository.js';

@Controller(['order/internal', 'internal'])
@UseGuards(ServiceKeyGuard)
export class InternalController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('orders/:id')
  async getInternalOrder(
    @Param('id') id: string,
  ): Promise<{ order: OrderWithDetails }> {
    const order = await this.ordersService.findOrderById(id, {
      userId: 'internal-service',
      roles: ['admin'],
    });
    return { order };
  }
}
