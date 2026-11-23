import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeadLetterProvider } from '../../providers/dead-letter.provider';
import { DeadLetterJob } from '../../entities/dead-letter-job.entity';
import { Repository } from 'typeorm';

describe('DeadLetterProvider', () => {
  let provider: DeadLetterProvider;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      create: jest.fn().mockImplementation((data) => ({ id: 'uuid-1', ...data })),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    const mod = await Test.createTestingModule({
      providers: [
        DeadLetterProvider,
        { provide: getRepositoryToken(DeadLetterJob), useValue: repo },
      ],
    }).compile();

    provider = mod.get(DeadLetterProvider);
  });

  it('storeFailedJob creates and saves a dead-letter job', async () => {
    const result = await provider.storeFailedJob({
      queueName: 'email',
      jobId: '1',
      jobName: 'send-email',
      data: { to: 'a@b.com' },
      errorMessage: 'connection reset',
      totalAttempts: 3,
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: 'email',
        jobId: '1',
        jobName: 'send-email',
        errorMessage: 'connection reset',
        totalAttempts: 3,
      }),
    );
    expect(repo.save).toHaveBeenCalled();
    expect(result.id).toBe('uuid-1');
  });

  it('updateStatus calls repo.update with status and retriedAt for non-retry statuses', async () => {
    await provider.updateStatus('uuid-1', 'resolved');
    expect(repo.update).toHaveBeenCalledWith('uuid-1', {
      status: 'resolved',
      retriedAt: expect.any(Date),
    });
  });

  describe('retry attempts', () => {
    let qb: {
      update: jest.Mock;
      set: jest.Mock;
      where: jest.Mock;
      andWhere: jest.Mock;
      execute: jest.Mock;
    };

    beforeEach(() => {
      qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      repo.createQueryBuilder.mockReturnValue(qb);
    });

    it('increments totalAttempts exactly once per accepted retry', async () => {
      await provider.updateStatus('uuid-1', 'retried');

      expect(qb.execute).toHaveBeenCalledTimes(1);
      expect(qb.set).toHaveBeenCalledTimes(1);
      const setArg = qb.set.mock.calls[0][0];
      expect(setArg.status).toBe('retried');
      expect(setArg.retriedAt).toBeInstanceOf(Date);
      expect(setArg.lastAttemptAt).toBeInstanceOf(Date);
      expect(typeof setArg.totalAttempts).toBe('function');
      expect(setArg.totalAttempts()).toBe('"totalAttempts" + 1');
      // Increment is atomic in SQL; no read-modify-write via update/save.
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('only retries jobs in a retryable status', async () => {
      await provider.updateStatus('uuid-1', 'retried');

      expect(qb.where).toHaveBeenCalledWith('id = :id', { id: 'uuid-1' });
      expect(qb.andWhere).toHaveBeenCalledWith('status IN (:...retryable)', {
        retryable: ['pending', 'failed'],
      });
    });

    it('increments once for each separate retry', async () => {
      await provider.updateStatus('uuid-1', 'retried');
      await provider.recordRetry('uuid-1');

      expect(qb.execute).toHaveBeenCalledTimes(2);
      expect(qb.set).toHaveBeenCalledTimes(2);
    });

    it('rejects a retry from a non-retryable status and leaves the count unchanged', async () => {
      qb.execute.mockResolvedValue({ affected: 0 });
      repo.findOne.mockResolvedValue({
        id: 'uuid-1',
        status: 'resolved',
        totalAttempts: 3,
      });

      await expect(provider.updateStatus('uuid-1', 'retried')).rejects.toThrow(
        ConflictException,
      );
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate retry of an already retried job', async () => {
      qb.execute.mockResolvedValue({ affected: 0 });
      repo.findOne.mockResolvedValue({
        id: 'uuid-1',
        status: 'retried',
        totalAttempts: 4,
      });

      await expect(provider.recordRetry('uuid-1')).rejects.toThrow(
        ConflictException,
      );
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the job does not exist', async () => {
      qb.execute.mockResolvedValue({ affected: 0 });
      repo.findOne.mockResolvedValue(null);

      await expect(provider.recordRetry('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('remove calls repo.delete', async () => {
    await provider.remove('uuid-1');
    expect(repo.delete).toHaveBeenCalledWith('uuid-1');
  });
});
