import { ReservationExpiryHandler } from './reservation-expiry.provider';
import { BookingStatus } from '../enums/booking-status.enum';

describe('ReservationExpiryHandler', () => {
  it('expires only pending reservations older than the expiry boundary', async () => {
    const update = jest.fn().mockResolvedValue({ affected: 2 });
    const handler = new ReservationExpiryHandler({ update } as never);

    await handler.expireStaleReservations();

    expect(update).toHaveBeenCalledWith(
      {
        status: BookingStatus.PENDING,
        createdAt: expect.any(Object),
      },
      { status: BookingStatus.CANCELLED },
    );
    expect(update.mock.calls[0][0].createdAt).toEqual(
      expect.objectContaining({ type: 'lessThan' }),
    );
    expect(update.mock.calls[0][0].createdAt.value).toBeInstanceOf(Date);
  });
});
