import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdempotencyKey } from '../entities/idempotency-key.entity';

/**
 * BE-29 — Periodic cleanup of expired idempotency keys.
 *
 * Runs every hour by default. The interval can be overridden via
 * the IDEMPOTENCY_CLEANUP_CRON environment variable.
 */
@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly repo: Repository<IdempotencyKey>,
  ) {}

  /**
   * A record is expired — and therefore reusable — once the current time
   * is at or past its `expiresAt`. The boundary is inclusive so a key whose
   * expiry equals "now" is released rather than lingering until the next
   * run.
   */
  static isExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
    if (!expiresAt) return false;
    return expiresAt.getTime() <= now.getTime();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async cleanup(now: Date = new Date()) {
    try {
      const result = await this.repo.delete({
        expiresAt: LessThanOrEqual(now),
      });
      const count = result.affected ?? 0;
      if (count > 0) {
        this.logger.log(`Cleaned up ${count} expired idempotency keys`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cleanup expired idempotency keys: ${(err as Error).message}`,
      );
    }
  }
}
