import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { RedisModule } from '../redis/redis.module.js';

@Module({
  imports: [RedisModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
