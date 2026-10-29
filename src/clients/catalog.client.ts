import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** A dead catalog must fail checkout in seconds, not hold the request open. */
const REQUEST_TIMEOUT_MS = 3_000;

export interface ProductSnapshot {
  productId: string;
  variantId?: string | null;
  productName: string;
  sku: string;
  unitPrice: number;
  effectivePrice?: number;
  imageUrl?: string | null;
  available: boolean;
  stock: number;
}

/**
 * The wire contract of `POST catalog/internal/stock/reserve`.
 * `qty` exists only in the public checkout DTO — the translation to
 * `quantity` happens here, at the service boundary.
 */
export interface StockReservationItem {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface ReservedItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  remainingStock: number;
}

export type StockFailure =
  /** 409 INSUFFICIENT_STOCK / RESERVATION_CLOSED / RESERVATION_CONFLICT */
  | 'insufficient_stock'
  /** 400/404/422 — the request itself is wrong (contract drift) */
  | 'invalid_request'
  /** 5xx, network error or timeout */
  | 'unavailable';

export type ReserveStockResult =
  | {
      ok: true;
      reservationId: string;
      status: 'held';
      expiresAt: string;
      items: ReservedItem[];
    }
  | { ok: false; failure: StockFailure; code?: string; message: string };

export type StockMutationResult =
  | { ok: true; status: string }
  | { ok: false; failure: StockFailure; message: string };

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

@Injectable()
export class CatalogClient {
  private readonly logger = new Logger(CatalogClient.name);
  private readonly catalogUrl: string;
  private readonly serviceKey: string;

  constructor(configService: ConfigService) {
    this.catalogUrl = (
      configService.get<string>('CATALOG_SVC_URL') ?? 'http://localhost:4020'
    ).replace(/\/+$/, '');
    this.serviceKey =
      configService.get<string>('INTERNAL_SERVICE_KEY') ??
      'dev-internal-service-key-change-in-prod';
  }

  /**
   * Holds stock for the duration of the checkout. `reservationId` is generated
   * by the caller and doubles as the idempotency key, so a replay after a
   * timeout returns the original hold instead of decrementing twice.
   */
  async reserveStock(
    reservationId: string,
    items: StockReservationItem[],
    orderId?: string,
  ): Promise<ReserveStockResult> {
    const res = await this.post('/api/v1/catalog/internal/stock/reserve', {
      reservationId,
      orderId,
      items,
    });

    if (!res) {
      return {
        ok: false,
        failure: 'unavailable',
        message: 'Unable to reach catalog service',
      };
    }

    if (res.status === 200 || res.status === 201) {
      const body = (await res.json()) as Omit<
        Extract<ReserveStockResult, { ok: true }>,
        'ok'
      >;
      return { ok: true, ...body };
    }

    const error = await this.readError(res);
    const failure = this.classify(res.status);
    this.logger.warn(
      `Catalog reserveStock failed (${res.status} ${error.code ?? 'unknown'}): ${error.message}`,
    );
    return { ok: false, failure, code: error.code, message: error.message };
  }

  /**
   * Consumes a hold. Stock was already decremented when the hold was placed,
   * so this never moves stock. Idempotent: an unknown or already closed hold is
   * reported as `ok`, because that is the desired end state.
   */
  async commitStock(
    reservationId: string,
    orderId?: string,
  ): Promise<StockMutationResult> {
    const res = await this.post('/api/v1/catalog/internal/stock/commit', {
      reservationId,
      orderId,
    });

    if (!res) {
      return {
        ok: false,
        failure: 'unavailable',
        message: 'Unable to reach catalog service',
      };
    }

    if (res.status === 200 || res.status === 201) {
      return { ok: true, status: 'committed' };
    }

    const error = await this.readError(res);
    return { ok: false, failure: this.classify(res.status), message: error.message };
  }

  /**
   * Compensation for a checkout that failed after the hold was placed. Only the
   * reservation id is sent — the caller can no longer dictate quantities, so a
   * retry can never inflate stock.
   */
  async releaseStock(reservationId: string): Promise<StockMutationResult> {
    const res = await this.post('/api/v1/catalog/internal/stock/release', {
      reservationId,
    });

    if (!res) {
      // The hold expires on its own, so this is a warning, not a failure.
      this.logger.warn(
        `Catalog releaseStock for ${reservationId} unreachable; the hold will expire`,
      );
      return { ok: false, failure: 'unavailable', message: 'Unable to reach catalog service' };
    }

    // 404/409 mean the hold is already gone or already terminal — the desired
    // end state for a compensation call.
    if (res.status === 404 || res.status === 409) {
      return { ok: true, status: 'closed' };
    }

    if (res.status === 200 || res.status === 201) {
      return { ok: true, status: 'released' };
    }

    const error = await this.readError(res);
    this.logger.warn(
      `Catalog releaseStock failed (${res.status}): ${error.message}`,
    );
    return {
      ok: false,
      failure: this.classify(res.status),
      message: error.message,
    };
  }

  /**
   * Prices checkout lines from catalog. The map is keyed by
   * `variantId ?? productId` because the endpoint resolves ids that are either
   * — a variant line must read back its own snapshot, not the product default.
   */
  async getProductSnapshots(
    ids: string[],
  ): Promise<Map<string, ProductSnapshot>> {
    const map = new Map<string, ProductSnapshot>();
    if (ids.length === 0) return map;

    const uniqueIds = Array.from(new Set(ids)).join(',');
    const url = `${this.catalogUrl}/api/v1/catalog/internal/products?ids=${uniqueIds}`;

    try {
      const res = await fetch(url, {
        headers: { 'x-service-key': this.serviceKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status !== 200) {
        this.logger.warn(`Catalog snapshots failed with status ${res.status}`);
        return map;
      }

      const body = (await res.json()) as { data: ProductSnapshot[] };
      for (const snapshot of body.data) {
        map.set(snapshot.variantId ?? snapshot.productId, snapshot);
      }
    } catch (error) {
      this.logger.warn(
        'Unable to fetch product snapshots from catalog-svc; falling back to item identifiers',
        error instanceof Error ? error.message : error,
      );
    }

    return map;
  }

  /** Returns null when the request never reached catalog (network or timeout). */
  private async post(path: string, body: unknown): Promise<Response | null> {
    try {
      return await fetch(`${this.catalogUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-service-key': this.serviceKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(
        `CatalogClient ${path} network error`,
        error instanceof Error ? error.stack : error,
      );
      return null;
    }
  }

  private async readError(
    res: Response,
  ): Promise<{ code?: string; message: string }> {
    const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
    return {
      code: body?.error?.code,
      message: body?.error?.message ?? `Catalog service returned HTTP ${res.status}`,
    };
  }

  private classify(status: number): StockFailure {
    if (status === 409) return 'insufficient_stock';
    if (status >= 500) return 'unavailable';
    return 'invalid_request';
  }
}
