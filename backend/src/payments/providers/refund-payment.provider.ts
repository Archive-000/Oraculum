import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Payment } from '../entities/payment.entity';
import { PaymentStatus } from '../enums/payment-status.enum';
import { PaystackProvider } from './paystack.provider';
import { UserRole } from '../../users/enums/userRoles.enum';

export function toMinorUnits(value: number | string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new BadRequestException('Refund amounts must be safe whole minor units');
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) throw new BadRequestException('Refund amounts must be whole minor units');
  return BigInt(value.trim());
}

export function assertRefundWithinCaptured(
  amount: number | string | bigint,
  alreadyRefunded: number | string | bigint,
  refundRequest: number | string | bigint,
): { nextRefunded: bigint; remainingAfter: bigint } {
  const captured = toMinorUnits(amount);
  const refunded = toMinorUnits(alreadyRefunded);
  const request = toMinorUnits(refundRequest);
  if (captured <= 0n || refunded < 0n || refunded > captured) {
    throw new BadRequestException('Payment captured/refunded amounts are invalid');
  }
  if (request <= 0n) throw new BadRequestException('Refund amount must be greater than zero');
  const remaining = captured - refunded;
  if (request > remaining) throw new BadRequestException(`Refund of ${request} exceeds remaining refundable balance of ${remaining}`);
  const nextRefunded = refunded + request;
  return { nextRefunded, remainingAfter: captured - nextRefunded };
}

@Injectable()
export class RefundPaymentProvider {
  constructor(
    @InjectRepository(Payment) private readonly paymentsRepository: Repository<Payment>,
    private readonly paystackProvider: PaystackProvider,
  ) {}

  async refund(paymentId: string, requestingUserId: string, requestingUserRole: UserRole, amount?: number): Promise<Payment> {
    const payment = await this.paymentsRepository.findOne({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException(`Payment "${paymentId}" not found`);

    const isAdmin = requestingUserRole === UserRole.ADMIN || requestingUserRole === UserRole.SUPER_ADMIN;
    if (!isAdmin && payment.userId !== requestingUserId) throw new ForbiddenException('You can only refund your own payments');
    if (payment.status === PaymentStatus.REFUNDING) throw new ConflictException('Refund already in progress');
    if (payment.status === PaymentStatus.REFUNDED) throw new BadRequestException('Payment is already refunded');
    if (payment.status !== PaymentStatus.SUCCESS) {
      throw new BadRequestException(`Only SUCCESS payments can be refunded. Current status: ${payment.status}`);
    }

    // Calculate and validate against the captured balance before reserving.
    const { nextRefunded, remainingAfter } = assertRefundWithinCaptured(
      payment.amount, payment.refundedAmount ?? 0,
      amount === undefined || amount === null
        ? toMinorUnits(payment.amount) - toMinorUnits(payment.refundedAmount ?? 0)
        : amount,
    );
    const requestAmount = nextRefunded - toMinorUnits(payment.refundedAmount ?? 0);
    if (requestAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadRequestException('Refund amount exceeds the provider supported range');
    }

    // Conditional state transition is the concurrency guard: only one caller
    // can reserve a SUCCESS payment and reach the external provider.
    const reserve = await this.paymentsRepository.createQueryBuilder()
      .update(Payment)
      .set({ status: PaymentStatus.REFUNDING })
      .where('id = :id', { id: paymentId })
      .andWhere('status = :status', { status: PaymentStatus.SUCCESS })
      .execute();
    if (!reserve.affected) throw new ConflictException('Refund already in progress or payment is no longer refundable');

    try {
      // Exactly one provider request; never issue an unbounded full refund first.
      await this.paystackProvider.initiateRefund(payment.providerReference, Number(requestAmount));
    } catch (error) {
      await this.paymentsRepository.update(
        { id: paymentId, status: PaymentStatus.REFUNDING },
        { status: PaymentStatus.SUCCESS },
      );
      throw error;
    }

    payment.refundedAmount = Number(nextRefunded);
    payment.status = remainingAfter === 0n ? PaymentStatus.REFUNDED : PaymentStatus.SUCCESS;
    payment.metadata = {
      ...(payment.metadata ?? {}),
      lastRefundAmount: Number(requestAmount),
      lastRefundAt: new Date().toISOString(),
    };
    return this.paymentsRepository.save(payment);
  }
}
