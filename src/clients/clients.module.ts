import { Module } from '@nestjs/common';
import { CatalogClient } from './catalog.client.js';

/**
 * Outbound HTTP clients, owned in one place. Checkout reserves stock through
 * catalog-svc and orders releases a hold through it when an order is cancelled;
 * providing the client twice would give two instances and, one day, a module
 * cycle. There is no cart client: conversion is cart-svc's own reaction to
 * `order.created` (ord-012), not a call from here.
 */
@Module({
  providers: [CatalogClient],
  exports: [CatalogClient],
})
export class ClientsModule {}
