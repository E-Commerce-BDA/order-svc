import { IsEnum } from 'class-validator';

export class PaymentRequestDto {
  @IsEnum(['mock', 'stripe', 'paypal'])
  provider!: 'mock' | 'stripe' | 'paypal';
}
