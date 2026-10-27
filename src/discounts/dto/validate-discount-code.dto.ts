import { IsNotEmpty, IsNumber, IsString, MaxLength, Min } from 'class-validator';

export class ValidateDiscountCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @IsNumber()
  @Min(0)
  cartTotal!: number;
}
