import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeadLetterJob } from '../entities/dead-letter-job.entity';

const RETRIED_STATUS = 'retried';
/** Statuses from which a dead-letter job may be retried. */
const RETRYABLE_STATUSES = ['pending', 'failed'];

@Injectable()
export class DeadLetterProvider {
  private readonly logger = new Logger(DeadLetterProvider.name);

  constructor(
    @InjectRepository(DeadLetterJob)
    private readonly deadLetterRepository: Repository<DeadLetterJob>,
  ) {}

  async storeFailedJob(payload: {
    queueName: string;
    jobId: string;
    jobName: string;
    data: Record<string, unknown>;
    errorMessage: string;
    totalAttempts: number;
    attemptsResult?: Record<string, unknown>;
  }): Promise<DeadLetterJob> {
    const job = this.deadLetterRepository.create({
      ...payload,
      lastAttemptAt: new Date(),
    });
    const saved = await this.deadLetterRepository.save(job);
    this.logger.warn(
      `Dead-letter job stored: ${saved.id} (queue=${payload.queueName}, job=${payload.jobName})`,
    );
    return saved;
  }

  async findAll(options?: {
    queueName?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ jobs: DeadLetterJob[]; total: number }> {
    const qb = this.deadLetterRepository.createQueryBuilder('job');

    if (options?.queueName) {
      qb.andWhere('job.queueName = :queueName', {
        queueName: options.queueName,
      });
    }
    if (options?.status) {
      qb.andWhere('job.status = :status', { status: options.status });
    }

    qb.orderBy('job.createdAt', 'DESC');

    const total = await qb.getCount();
    const jobs = await qb
      .skip(options?.offset ?? 0)
      .take(options?.limit ?? 50)
      .getMany();

    return { jobs, total };
  }

  async findById(id: string): Promise<DeadLetterJob | null> {
    return this.deadLetterRepository.findOne({ where: { id } });
  }

  async updateStatus(id: string, status: string): Promise<void> {
    if (status === RETRIED_STATUS) {
      await this.recordRetry(id);
      return;
    }

    await this.deadLetterRepository.update(id, {
      status,
      retriedAt: new Date(),
    });
  }

  /**
   * Records a retry attempt. The status change and the attempt increment
   * happen in a single conditional UPDATE so that:
   *  - `totalAttempts` is incremented exactly once per accepted retry,
   *    even when concurrent retry requests race each other;
   *  - a rejected retry (unknown job or non-retryable status) leaves
   *    `totalAttempts` untouched.
   */
  async recordRetry(id: string): Promise<void> {
    const now = new Date();

    const result = await this.deadLetterRepository
      .createQueryBuilder()
      .update(DeadLetterJob)
      .set({
        status: RETRIED_STATUS,
        retriedAt: now,
        lastAttemptAt: now,
        totalAttempts: () => '"totalAttempts" + 1',
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...retryable)', {
        retryable: RETRYABLE_STATUSES,
      })
      .execute();

    if ((result.affected ?? 0) === 1) {
      return;
    }

    const existing = await this.deadLetterRepository.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Dead-letter job "${id}" not found`);
    }

    throw new ConflictException(
      `Dead-letter job "${id}" cannot be retried from status "${existing.status}"`,
    );
  }

  async remove(id: string): Promise<void> {
    await this.deadLetterRepository.delete(id);
  }
}
