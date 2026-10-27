import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DiscountsService, DiscountValidationResult } from './discounts.service.js';
import { ValidateDiscountCodeDto } from './dto/validate-discount-code.dto.js';
import { CreateDiscountCodeDto } from './dto/create-discount-code.dto.js';
import { UpdateDiscountCodeDto } from './dto/update-discount-code.dto.js';
import { DiscountQueryDto } from './dto/discount-query.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { DiscountCodeRow } from '../db/rows.js';

@Controller(['order/discount-codes', 'discount-codes'])
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  /**
   * Public / Customer coupon validation endpoint.
   * Checks expiration, min order amount, max uses, and calculates discount.
   */
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validate(
    @Body() dto: ValidateDiscountCodeDto,
  ): Promise<DiscountValidationResult> {
    return this.discountsService.validate(dto.code, dto.cartTotal);
  }

  /**
   * Admin: List discount codes with pagination.
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async findAll(@Query() query: DiscountQueryDto): Promise<{
    data: DiscountCodeRow[];
    total: number;
    page: number;
    perPage: number;
  }> {
    return this.discountsService.findAll(query);
  }

  /**
   * Admin: Create a new coupon.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateDiscountCodeDto,
  ): Promise<{ code: DiscountCodeRow }> {
    const code = await this.discountsService.create(dto);
    return { code };
  }

  /**
   * Admin: Get coupon by id.
   */
  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async findById(@Param('id') id: string): Promise<{ code: DiscountCodeRow }> {
    const code = await this.discountsService.findById(id);
    return { code };
  }

  /**
   * Admin: Update coupon details.
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateDiscountCodeDto,
  ): Promise<{ code: DiscountCodeRow }> {
    const code = await this.discountsService.update(id, dto);
    return { code };
  }

  /**
   * Admin: Delete coupon by id.
   */
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    await this.discountsService.delete(id);
  }
}
