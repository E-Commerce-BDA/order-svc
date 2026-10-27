import { Request } from 'express';
import { randomUUID } from 'node:crypto';

/**
 * Extracts the gateway request id when present; otherwise generates a fresh UUIDv4
 * to trace direct service-to-service calls.
 */
export function getRequestId(request: Request): string {
  const header = request.headers['x-request-id'];

  if (Array.isArray(header)) {
    return header[0]?.trim() || randomUUID();
  }

  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  return randomUUID();
}
