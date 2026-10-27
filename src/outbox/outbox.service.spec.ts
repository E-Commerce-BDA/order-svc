import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxService } from './outbox.service.js';
import { OutboxRepository } from './outbox.repository.js';
import type { OutboxRow } from '../db/rows.js';

describe('OutboxService', () => {
  let service: OutboxService;
  let repo: Partial<Record<keyof OutboxRepository, ReturnType<typeof vi.fn>>>;

  const sampleEvents: OutboxRow[] = [
    {
      id: 'out-1',
      event_id: 'evt-1',
      aggregate_type: 'order',
      aggregate_id: 'ord-101',
      event_type: 'order.created',
      payload: { orderId: 'ord-101' },
      status: 'pending',
      attempts: 0,
      created_at: '2026-10-27T10:00:00Z',
      published_at: null,
    },
  ];

  beforeEach(() => {
    repo = {
      fetchPendingEvents: vi.fn(),
      markPublished: vi.fn(),
      markFailed: vi.fn(),
    };
    service = new OutboxService(repo as unknown as OutboxRepository);
  });

  it('dispatches pending events and marks them published', async () => {
    repo.fetchPendingEvents!.mockResolvedValue(sampleEvents);
    const dispatchSpy = vi.spyOn(service, 'dispatchEvent').mockResolvedValue(undefined);

    const count = await service.processPendingEvents(10);

    expect(count).toBe(1);
    expect(dispatchSpy).toHaveBeenCalledWith(sampleEvents[0]);
    expect(repo.markPublished).toHaveBeenCalledWith('out-1');
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('marks event as failed if dispatch throws error', async () => {
    repo.fetchPendingEvents!.mockResolvedValue(sampleEvents);
    vi.spyOn(service, 'dispatchEvent').mockRejectedValue(new Error('Broker unreachable'));

    const count = await service.processPendingEvents(10);

    expect(count).toBe(1);
    expect(repo.markPublished).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledWith('out-1');
  });

  it('prevents concurrent execution when processPendingEvents is already running', async () => {
    repo.fetchPendingEvents!.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return sampleEvents;
    });

    const p1 = service.processPendingEvents(10);
    const p2 = service.processPendingEvents(10);

    const [c1, c2] = await Promise.all([p1, p2]);
    expect(c1).toBe(1);
    expect(c2).toBe(0);
  });
});
