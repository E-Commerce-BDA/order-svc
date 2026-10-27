import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CheckoutItemDto } from './checkout-item.dto.js';
import { AddressDto } from './address.dto.js';
import { PaymentRequestDto } from './payment-request.dto.js';

export class CheckoutDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CheckoutItemDto)
  items!: CheckoutItemDto[];

  @ValidateNested()
  @Type(() => AddressDto)
  shippingAddress!: AddressDto;

  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress!: AddressDto;

  @IsOptional()
  @IsString()
  discountCode?: string;

  @ValidateNested()
  @Type(() => PaymentRequestDto)
  payment!: PaymentRequestDto;

  @IsOptional()
  @IsString()
  notes?: string;
}
