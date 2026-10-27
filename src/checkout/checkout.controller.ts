import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CheckoutService, CheckoutConfirmation } from './checkout.service.js';
import { CheckoutDto } from './dto/checkout.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard.js';

@Controller(['order/checkout', 'checkout'])
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async checkout(
    @Req() req: AuthenticatedRequest,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutConfirmation> {
    const userId = req.user?.sub ?? '018f0000-0000-7000-8000-000000000001';
    return this.checkoutService.checkout(userId, idempotencyKey, dto);
  }
}
