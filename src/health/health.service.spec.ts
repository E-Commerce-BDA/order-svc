import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HealthService } from './health.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ServiceUnavailableException } from '@nestjs/common';
import * as dbPool from '../db/pool.js';

describe('HealthService', () => {
  let service: HealthService;
  let mockRedisService: { ping: ReturnType<typeof vi.fn> };
  let mockPool: { query: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockRedisService = {
      ping: vi.fn(),
    };

    mockPool = {
      query: vi.fn(),
    };

    vi.spyOn(dbPool, 'getPool').mockReturnValue(mockPool as any);

    service = new HealthService(mockRedisService as unknown as RedisService);
  });

  describe('checkLiveness', () => {
    it('returns status ok without calling dependencies', () => {
      const result = service.checkLiveness();
      expect(result).toEqual({ status: 'ok' });
      expect(mockPool.query).not.toHaveBeenCalled();
      expect(mockRedisService.ping).not.toHaveBeenCalled();
    });
  });

  describe('checkReadiness', () => {
    it('returns ready when both Postgres and Redis are up', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      mockRedisService.ping.mockResolvedValueOnce(true);

      const result = await service.checkReadiness();
      expect(result).toEqual({
        status: 'ready',
        checks: { db: 'up', redis: 'up' },
      });
    });

    it('throws ServiceUnavailableException when DB is down', async () => {
      mockPool.query.mockRejectedValueOnce(new Error('DB unreachable'));
      mockRedisService.ping.mockResolvedValueOnce(true);

      await expect(service.checkReadiness()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws ServiceUnavailableException when Redis is down', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
      mockRedisService.ping.mockResolvedValueOnce(false);

      await expect(service.checkReadiness()).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });
});
