import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class AddressDto {
  @IsString()
  @IsNotEmpty()
  line1!: string;

  @IsOptional()
  @IsString()
  line2?: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsString()
  @IsNotEmpty()
  postalCode!: string;

  @IsString()
  @IsNotEmpty()
  @Length(2, 2)
  country!: string;
}
