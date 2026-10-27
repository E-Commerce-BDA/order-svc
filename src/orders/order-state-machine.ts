import { BadRequestException } from '@nestjs/common';
import type { OrderStatus } from '../db/rows.js';

/**
 * Finite state machine graph governing order lifecycle transitions.
 * Terminal states: 'cancelled', 'failed', 'refunded'.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'failed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  failed: [],
  refunded: [],
};

/**
 * Checks whether an order can transition from current status to next status.
 */
export function canTransition(current: OrderStatus, next: OrderStatus): boolean {
  if (current === next) {
    return false;
  }
  const allowed = ALLOWED_STATUS_TRANSITIONS[current] ?? [];
  return allowed.includes(next);
}

/**
 * Asserts that the transition is valid, throwing a 400 BadRequestException if invalid.
 */
export function assertValidTransition(current: OrderStatus, next: OrderStatus): void {
  if (!canTransition(current, next)) {
    const allowed = ALLOWED_STATUS_TRANSITIONS[current] ?? [];
    const allowedStr = allowed.length > 0 ? allowed.join(', ') : 'none (terminal state)';
    throw new BadRequestException(
      `Invalid order status transition from '${current}' to '${next}'. Allowed next states: [${allowedStr}]`,
    );
  }
}
