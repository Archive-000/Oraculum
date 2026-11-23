import { BadRequestException } from '@nestjs/common';
import { ConfirmBookingProvider } from './confirm-booking.provider';
import { Booking } from '../entities/booking.entity';
import { BookingStatus } from '../enums/booking-status.enum';
import { User } from '../../users/entities/user.entity';

describe('ConfirmBookingProvider reservation expiry', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  function createProvider(booking: Partial<Booking>) {
    const findOne = jest.fn(async (entity: unknown) => {
      if (entity === Booking) return booking as Booking;
      return null;
    });
    const save = jest.fn(async (entity: unknown) => entity);
    const manager = { findOne, save };
    const provider = new ConfirmBookingProvider(
      {} as never,
      {} as never,
      {} as never,
      { invalidateBookingList: jest.fn().mockResolvedValue(undefined) } as never,
    );
    return { provider, manager, findOne, save };
  }

  it('rejects a pending reservation after its expiry window', async () => {
    const { provider, manager, findOne, save } = createProvider({
      id: 'booking-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      status: BookingStatus.PENDING,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000 - 1),
    });

    await expect(
      provider.confirm('booking-1', manager as never, now),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findOne).toHaveBeenCalledWith(Booking, {
      where: { id: 'booking-1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(save).not.toHaveBeenCalled();
  });

  it('confirms a pending reservation still within its expiry window', async () => {
    const { provider, manager, save } = createProvider({
      id: 'booking-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      status: BookingStatus.PENDING,
      createdAt: new Date(now.getTime() - 30 * 60 * 1000),
    });

    await expect(
      provider.confirm('booking-1', manager as never, now),
    ).resolves.toMatchObject({ status: BookingStatus.CONFIRMED });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
