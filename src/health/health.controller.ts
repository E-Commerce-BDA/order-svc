import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  checkLiveness(): { status: 'ok' } {
    return this.healthService.checkLiveness();
  }

  @Get('ready')
  checkReadiness(): Promise<{
    status: 'ready';
    checks: { db: 'up'; redis: 'up' };
  }> {
    return this.healthService.checkReadiness();
  }
}
