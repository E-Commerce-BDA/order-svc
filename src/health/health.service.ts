import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { getPool } from '../db/pool.js';
import { RedisService } from '../redis/redis.service.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly redisService: RedisService) {}

  /**
   * Liveness: is this process able to answer HTTP?
   * Performs no external dependency calls.
   */
  checkLiveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: probes PostgreSQL and Redis.
   */
  async checkReadiness(): Promise<{
    status: 'ready';
    checks: { db: 'up'; redis: 'up' };
  }> {
    let dbStatus: 'up' | 'down' = 'down';
    let redisStatus: 'up' | 'down' = 'down';

    try {
      await getPool().query('SELECT 1');
      dbStatus = 'up';
    } catch (error) {
      this.logger.error(
        'Database connection failed',
        error instanceof Error ? error.stack : '',
      );
    }

    try {
      const redisUp = await this.redisService.ping();
      redisStatus = redisUp ? 'up' : 'down';
    } catch (error) {
      this.logger.error(
        'Redis ping failed',
        error instanceof Error ? error.stack : '',
      );
    }

    if (dbStatus !== 'up' || redisStatus !== 'up') {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { db: dbStatus, redis: redisStatus },
      });
    }

    return {
      status: 'ready',
      checks: { db: 'up', redis: 'up' },
    };
  }
}
