import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DiscountsRepository } from './discounts.repository.js';
import { CreateDiscountCodeDto } from './dto/create-discount-code.dto.js';
import { UpdateDiscountCodeDto } from './dto/update-discount-code.dto.js';
import { DiscountQueryDto } from './dto/discount-query.dto.js';
import type { DiscountCodeRow } from '../db/rows.js';

export interface DiscountValidationResult {
  valid: boolean;
  code?: string;
  discountType?: 'percent' | 'fixed';
  value?: number;
  discount?: number;
  message?: string;
  id?: string;
}

@Injectable()
export class DiscountsService {
  constructor(private readonly repository: DiscountsRepository) {}

  async validate(code: string, cartTotal: number): Promise<DiscountValidationResult> {
    if (!code || !code.trim()) {
      return { valid: false, message: 'Discount code is required' };
    }

    const row = await this.repository.findByCode(code);
    if (!row) {
      return { valid: false, message: 'Invalid discount code' };
    }

    if (!row.is_active) {
      return { valid: false, message: 'Discount code is inactive' };
    }

    const now = new Date();
    if (row.starts_at && now < new Date(row.starts_at)) {
      return { valid: false, message: 'Discount code is not active yet' };
    }

    if (row.ends_at && now > new Date(row.ends_at)) {
      return { valid: false, message: 'Discount code has expired' };
    }

    if (row.max_uses !== null && row.uses_count >= row.max_uses) {
      return { valid: false, message: 'Discount code usage limit reached' };
    }

    const minAmount = row.min_order_amount ? parseFloat(row.min_order_amount) : 0;
    if (cartTotal < minAmount) {
      return {
        valid: false,
        message: `Order total does not meet minimum order amount of $${minAmount.toFixed(2)}`,
      };
    }

    const numericValue = parseFloat(row.value);
    let discount = 0;

    if (row.discount_type === 'percent') {
      discount = Math.round(((cartTotal * numericValue) / 100) * 100) / 100;
    } else {
      discount = Math.min(numericValue, cartTotal);
    }

    // Ensure 2 decimal places and non-negative
    discount = Math.max(0, Math.round(discount * 100) / 100);

    return {
      valid: true,
      id: row.id,
      code: row.code,
      discountType: row.discount_type,
      value: numericValue,
      discount,
    };
  }

  async findAll(query: DiscountQueryDto): Promise<{
    data: DiscountCodeRow[];
    total: number;
    page: number;
    perPage: number;
  }> {
    const page = query.page ?? 1;
    const perPage = query.perPage ?? 20;
    return this.repository.findAll(page, perPage);
  }

  async findById(id: string): Promise<DiscountCodeRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw new NotFoundException(`Discount code with id ${id} not found`);
    }
    return row;
  }

  async create(dto: CreateDiscountCodeDto): Promise<DiscountCodeRow> {
    if (dto.discountType === 'percent' && dto.value > 100) {
      throw new BadRequestException('Percentage discount value cannot exceed 100%');
    }

    const existing = await this.repository.findByCode(dto.code);
    if (existing) {
      throw new ConflictException(`Discount code "${dto.code.trim().toUpperCase()}" already exists`);
    }

    return this.repository.create(dto);
  }

  async update(id: string, dto: UpdateDiscountCodeDto): Promise<DiscountCodeRow> {
    const existing = await this.findById(id);

    const targetType = dto.discountType ?? existing.discount_type;
    const targetValue = dto.value !== undefined ? dto.value : parseFloat(existing.value);

    if (targetType === 'percent' && targetValue > 100) {
      throw new BadRequestException('Percentage discount value cannot exceed 100%');
    }

    if (dto.code && dto.code.trim().toUpperCase() !== existing.code) {
      const codeTaken = await this.repository.findByCode(dto.code);
      if (codeTaken && codeTaken.id !== id) {
        throw new ConflictException(`Discount code "${dto.code.trim().toUpperCase()}" already exists`);
      }
    }

    const updated = await this.repository.update(id, dto);
    if (!updated) {
      throw new NotFoundException(`Discount code with id ${id} not found`);
    }
    return updated;
  }

  async delete(id: string): Promise<void> {
    const deleted = await this.repository.delete(id);
    if (!deleted) {
      throw new NotFoundException(`Discount code with id ${id} not found`);
    }
  }
}
