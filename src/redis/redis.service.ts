import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(configService: ConfigService) {
    const url =
      configService.get<string>('REDIS_URL') ?? DEFAULT_REDIS_URL;

    this.client = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis connection error: ${error.message}`);
    });
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async setnx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
