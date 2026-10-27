import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CartClient {
  private readonly logger = new Logger(CartClient.name);
  private readonly cartUrl: string;
  private readonly serviceKey: string;

  constructor(configService: ConfigService) {
    this.cartUrl =
      configService.get<string>('CART_SVC_URL') ?? 'http://localhost:4030';
    this.serviceKey =
      configService.get<string>('INTERNAL_SERVICE_KEY') ?? 'dev-internal-service-key-change-in-prod';
  }

  /**
   * Best-effort notification to cart-svc to convert/clear user cart post-checkout.
   */
  async clearCart(userId: string): Promise<void> {
    try {
      const url = `${this.cartUrl}/api/v1/cart/internal/carts/${userId}`;
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'x-service-key': this.serviceKey,
        },
      });
    } catch {
      // Fire-and-forget: cart conversion failure must not fail order confirmation
      this.logger.debug(`Could not reach cart-svc to clear cart for user ${userId}`);
    }
  }
}
