import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ProductSnapshot {
  productId: string;
  productName: string;
  sku: string;
  unitPrice: number;
  effectivePrice?: number;
  imageUrl?: string | null;
  available: boolean;
  stock: number;
}

export interface StockReservationItem {
  productId: string;
  variantId?: string;
  qty: number;
}

export interface StockReservationResponse {
  success: boolean;
  reservedItems: number;
  reservedUntil?: string;
  errorMessage?: string;
}

@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);
  private readonly catalogUrl: string;
  private readonly serviceKey: string;

  constructor(configService: ConfigService) {
    this.catalogUrl =
      configService.get<string>('CATALOG_SVC_URL') ?? 'http://localhost:4020';
    this.serviceKey =
      configService.get<string>('INTERNAL_SERVICE_KEY') ?? 'dev-internal-service-key-change-in-prod';
  }

  async reserveStock(
    reservationId: string,
    items: StockReservationItem[],
  ): Promise<StockReservationResponse> {
    try {
      const url = `${this.catalogUrl}/api/v1/catalog/internal/stock/reserve`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': this.serviceKey,
        },
        body: JSON.stringify({ reservationId, items }),
      });

      if (res.status === 200 || res.status === 201) {
        const body = (await res.json()) as {
          success: boolean;
          reservedItems: number;
          reservedUntil: string;
        };
        return {
          success: true,
          reservedItems: body.reservedItems,
          reservedUntil: body.reservedUntil,
        };
      }

      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return {
          success: false,
          reservedItems: 0,
          errorMessage: body.message ?? 'Stock insufficient for one or more items',
        };
      }

      this.logger.warn(`Catalog reserveStock failed with status ${res.status}`);
      return {
        success: false,
        reservedItems: 0,
        errorMessage: `Catalog service returned HTTP ${res.status}`,
      };
    } catch (error) {
      this.logger.error(
        'CatalogClient reserveStock network error',
        error instanceof Error ? error.stack : error,
      );
      return {
        success: false,
        reservedItems: 0,
        errorMessage: 'Unable to connect to catalog service',
      };
    }
  }

  async releaseStock(
    reservationId: string,
    items: StockReservationItem[],
  ): Promise<{ success: boolean; releasedCount: number }> {
    try {
      const url = `${this.catalogUrl}/api/v1/catalog/internal/stock/release`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': this.serviceKey,
        },
        body: JSON.stringify({ reservationId, items }),
      });

      if (res.status === 200 || res.status === 201) {
        const body = (await res.json()) as { success: boolean; releasedCount: number };
        return { success: true, releasedCount: body.releasedCount };
      }

      return { success: false, releasedCount: 0 };
    } catch (error) {
      this.logger.error(
        'CatalogClient releaseStock error',
        error instanceof Error ? error.stack : error,
      );
      return { success: false, releasedCount: 0 };
    }
  }

  async getProductSnapshots(
    productIds: string[],
  ): Promise<Map<string, ProductSnapshot>> {
    const map = new Map<string, ProductSnapshot>();
    if (productIds.length === 0) return map;

    try {
      const uniqueIds = Array.from(new Set(productIds)).join(',');
      const url = `${this.catalogUrl}/api/v1/catalog/internal/products?ids=${uniqueIds}`;
      const res = await fetch(url, {
        headers: {
          'x-service-key': this.serviceKey,
        },
      });

      if (res.status === 200) {
        const body = (await res.json()) as { data: ProductSnapshot[] };
        for (const item of body.data) {
          map.set(item.productId, item);
        }
      }
    } catch (error) {
      this.logger.warn(
        'Unable to fetch product snapshots from catalog-svc; falling back to item identifiers',
        error instanceof Error ? error.message : error,
      );
    }

    return map;
  }
}
