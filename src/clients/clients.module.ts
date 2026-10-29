import { Module } from '@nestjs/common';
import { CatalogClient } from './catalog.client.js';
import { CartClient } from './cart.client.js';

/**
 * Outbound HTTP clients, owned in one place. Checkout needs both, and orders
 * needs catalog to release a stock hold when an order is cancelled — providing
 * the clients twice would give two instances and, one day, a module cycle.
 */
@Module({
  providers: [CatalogClient, CartClient],
  exports: [CatalogClient, CartClient],
})
export class ClientsModule {}
