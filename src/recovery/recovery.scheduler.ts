import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecoveryService } from './recovery.service.js';

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Periodic trigger, deliberately separate from the sweep: tests call
 * `RecoveryService.sweep()` directly so a background timer cannot make their
 * assertions racy. The timer is unref'd and disabled in tests, matching the
 * other sweeps in the polyrepo.
 */
@Injectable()
export class RecoveryScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecoveryScheduler.name);
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    config: ConfigService,
    private readonly recovery: RecoveryService,
  ) {
    this.intervalMs = config.get<number>(
      'RECOVERY_SWEEP_INTERVAL_MS',
      DEFAULT_INTERVAL_MS,
    );
    const disabled = config.get<string | boolean>('DISABLE_RECOVERY_SWEEP', false);
    this.enabled =
      disabled !== true && disabled !== 'true' && process.env.NODE_ENV !== 'test';
  }

  onModuleInit(): void {
    if (!this.enabled) return;

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.logger.log(`Recovery sweep started (every ${this.intervalMs} ms)`);
  }

  onModuleDestroy(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      await this.recovery.sweep();
    } catch (error) {
      this.logger.error(
        'Recovery sweep failed',
        error instanceof Error ? error.stack : error,
      );
    } finally {
      this.inFlight = false;
    }
  }
}
