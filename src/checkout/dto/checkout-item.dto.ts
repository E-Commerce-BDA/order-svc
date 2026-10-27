import { IsInt, IsNotEmpty, IsOptional, IsUUID, Min } from 'class-validator';

export class CheckoutItemDto {
  @IsUUID()
  @IsNotEmpty()
  productId!: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsInt()
  @Min(1)
  qty!: number;
}
