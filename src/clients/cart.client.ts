import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CONVERT_TIMEOUT_MS = 2000;

@Injectable()
export class CartClient {
  private readonly logger = new Logger(CartClient.name);
  private readonly cartUrl: string;
  private readonly serviceKey: string;

  constructor(configService: ConfigService) {
    this.cartUrl =
      configService.get<string>('CART_SVC_URL') ?? 'http://localhost:4030';
    this.serviceKey =
      configService.get<string>('INTERNAL_SERVICE_KEY') ??
      'dev-internal-service-key-change-in-prod';
  }

  /**
   * Phase-0 bridge: cart-svc converts the user's active cart once the order is
   * confirmed. Replaced by the `order.created` consumer in ca-009. Best effort
   * by contract: a cart that stays active costs an abandoned-cart email, never
   * the order.
   */
  async convertCart(userId: string): Promise<void> {
    const url = `${this.cartUrl}/api/v1/cart/internal/carts/${userId}/convert`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-service-key': this.serviceKey,
        },
        signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
      });

      if (!response.ok) {
        this.logger.warn(
          `cart-svc answered ${response.status} when converting the cart for user ${userId}`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Could not reach cart-svc to convert the cart for user ${userId}: ${detail}`,
      );
    }
  }
}
