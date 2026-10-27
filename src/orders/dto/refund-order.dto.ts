import { IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class RefundOrderDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
