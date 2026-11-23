import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LessThanOrEqual } from 'typeorm';
import { IdempotencyCleanupService } from './idempotency-cleanup.service';
import { IdempotencyKey } from '../entities/idempotency-key.entity';

describe('IdempotencyCleanupService', () => {
  let service: IdempotencyCleanupService;
  const mockDelete = jest.fn().mockResolvedValue({ affected: 3 });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdempotencyCleanupService,
        {
          provide: getRepositoryToken(IdempotencyKey),
          useValue: { delete: mockDelete },
        },
      ],
    }).compile();

    service = module.get(IdempotencyCleanupService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('deletes keys at or past their expiration (inclusive boundary)', async () => {
    await service.cleanup();
    expect(mockDelete).toHaveBeenCalledWith({
      expiresAt: LessThanOrEqual(expect.any(Date)),
    });
  });

  it('uses the supplied clock as the cutoff', async () => {
    const now = new Date('2026-01-01T12:00:00.000Z');
    await service.cleanup(now);
    expect(mockDelete).toHaveBeenCalledWith({ expiresAt: LessThanOrEqual(now) });
  });

  it('defaults the cutoff to the current system time', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-03-15T08:30:00.000Z');
    jest.setSystemTime(now);

    await service.cleanup();

    const [[criteria]] = mockDelete.mock.calls;
    expect(criteria.expiresAt.value.getTime()).toBe(now.getTime());
  });

  it('does not throw on repository errors', async () => {
    mockDelete.mockRejectedValueOnce(new Error('db down'));
    await expect(service.cleanup()).resolves.toBeUndefined();
  });

  it('handles a missing affected count', async () => {
    mockDelete.mockResolvedValueOnce({});
    await expect(service.cleanup()).resolves.toBeUndefined();
  });

  describe('isExpired clock boundaries', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');

    it('treats a record expiring exactly now as expired/reusable', () => {
      expect(IdempotencyCleanupService.isExpired(new Date(now.getTime()), now)).toBe(true);
    });

    it('treats a record 1ms past expiration as expired/reusable', () => {
      expect(IdempotencyCleanupService.isExpired(new Date(now.getTime() - 1), now)).toBe(true);
    });

    it('treats a record 1ms before expiration as still active', () => {
      expect(IdempotencyCleanupService.isExpired(new Date(now.getTime() + 1), now)).toBe(false);
    });

    it('treats a record with no expiry as not expired', () => {
      expect(IdempotencyCleanupService.isExpired(null, now)).toBe(false);
      expect(IdempotencyCleanupService.isExpired(undefined, now)).toBe(false);
    });

    it('defaults to the current system time', () => {
      jest.useFakeTimers();
      jest.setSystemTime(now);
      expect(IdempotencyCleanupService.isExpired(new Date(now.getTime()))).toBe(true);
      expect(IdempotencyCleanupService.isExpired(new Date(now.getTime() + 1000))).toBe(false);
    });
  });
});
