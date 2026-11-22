import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Payment } from '../entities/payment.entity';
import { PaymentProvider } from '../enums/payment-provider.enum';
import { PaymentStatus } from '../enums/payment-status.enum';
import { PaystackProvider } from './paystack.provider';
import { Booking } from '../../bookings/entities/booking.entity';
import { BookingStatus } from '../../bookings/enums/booking-status.enum';
import { User } from '../../users/entities/user.entity';
import { runInTransaction } from '../../common/utils/run-in-transaction';

/**
 * Validates a booking total before it is sent to the payment provider (#860).
 *
 * Amounts are held in kobo, the smallest unit Paystack accepts, so the only
 * supported precision is a whole number. The column is a bigint, which the
 * driver returns as a numeric string, so digit-only strings are accepted and
 * everything else (fractions, signs, exponents, blanks, NaN, Infinity,
 * values beyond Number.MAX_SAFE_INTEGER) is rejected before any payment row
 * or provider request is created.
 */
export function assertValidPaymentAmount(
  raw: unknown,
  bookingId: string,
): number {
  let amount = Number.NaN;
  if (typeof raw === 'number') {
    amount = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    amount = Number(raw);
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BadRequestException(
      `Booking "${bookingId}" has an invalid payment amount. ` +
        'The amount must be a positive whole number of kobo.',
    );
  }
  return amount;
}

/**
 * Initializes a payment for a booking (BE-12 acceptance).
 *
 * The Payment row creation and the Paystack reference back-fill are
 * wrapped in a transaction so that a half-saved Payment that never
 * received a `providerReference` cannot leak into the system.
 */
@Injectable()
export class InitializePaymentProvider {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(Booking)
    private readonly bookingsRepository: Repository<Booking>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly paystackProvider: PaystackProvider,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async initialize(
    bookingId: string,
    userId: string,
  ): Promise<{
    paymentId: string;
    authorizationUrl: string;
    reference: string;
  }> {
    const booking = await this.bookingsRepository.findOne({
      where: { id: bookingId, userId },
    });
    if (!booking) {
      throw new NotFoundException(`Booking "${bookingId}" not found`);
    }
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException(
        'Only PENDING bookings can be paid. This booking is: ' + booking.status,
      );
    }

    // Reject unusable amounts before touching the database or Paystack.
    const amount = assertValidPaymentAmount(booking.totalAmount, bookingId);

    // Re-use the existing pending payment if one exists. This is the
    // typical "user clicked pay → cancelled → clicked pay again" path.
    const existing = await this.paymentsRepository.findOne({
      where: { bookingId, status: PaymentStatus.PENDING },
    });
    if (existing) {
      // For an existing pending record we just refresh the
      // Paystack authorization URL; we do NOT touch the DB here.
      const user = await this.usersRepository.findOne({
        where: { id: userId },
      });
      if (!user) {
        throw new NotFoundException(`User "${userId}" not found`);
      }
      const paystackData = await this.paystackProvider.initializeTransaction(
        user.email,
        amount,
        existing.id,
        this.configService.get('FRONTEND_PAYMENT_CALLBACK_URL'),
        { bookingId },
      );
      return {
        paymentId: existing.id,
        authorizationUrl: paystackData.authorization_url,
        reference: paystackData.reference,
      };
    }

    // New payment flow — create the local row, call Paystack, then
    // back-fill the reference, all inside a transaction.
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User "${userId}" not found`);
    }

    return runInTransaction(this.dataSource, async (manager) => {
      const payment = manager.create(Payment, {
        bookingId,
        userId,
        amount: amount,
        provider: PaymentProvider.PAYSTACK,
        status: PaymentStatus.PENDING,
      });
      const savedPayment = await manager.save(payment);

      const paystackData = await this.paystackProvider.initializeTransaction(
        user.email,
        amount,
        savedPayment.id, // use payment UUID as Paystack reference
        this.configService.get('FRONTEND_PAYMENT_CALLBACK_URL'),
        { bookingId, userId },
      );

      savedPayment.providerReference = paystackData.reference;
      const refreshed = await manager.save(savedPayment);

      return {
        paymentId: refreshed.id,
        authorizationUrl: paystackData.authorization_url,
        reference: paystackData.reference,
      };
    });
  }
}
