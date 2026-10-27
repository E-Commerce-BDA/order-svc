import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import type { OrderStatus } from '../../db/rows.js';

export const ORDER_STATUS_VALUES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'failed',
  'refunded',
];

export class UpdateOrderStatusDto {
  @IsEnum(ORDER_STATUS_VALUES, {
    message: `status must be one of: ${ORDER_STATUS_VALUES.join(', ')}`,
  })
  status!: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
