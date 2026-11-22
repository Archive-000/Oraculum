import { ConflictException, BadRequestException } from '@nestjs/common';
import { RefundPaymentProvider, assertRefundWithinCaptured } from './refund-payment.provider';
import { PaymentStatus } from '../enums/payment-status.enum';
import { UserRole } from '../../users/enums/userRoles.enum';

describe('RefundPaymentProvider (B29)', () => {
  const paymentId = 'pay-1';
  let repo: { findOne: jest.Mock; createQueryBuilder: jest.Mock; update: jest.Mock; save: jest.Mock };
  let paystack: { initiateRefund: jest.Mock };
  let provider: RefundPaymentProvider;
  let reserveAffected = 1;

  beforeEach(() => {
    reserveAffected = 1;
    repo = {
      findOne: jest.fn().mockResolvedValue({ id: paymentId, userId: 'user-1', status: PaymentStatus.SUCCESS, providerReference: 'ref-1', amount: 10000, refundedAmount: 0, metadata: {} }),
      createQueryBuilder: jest.fn().mockReturnValue({ update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ andWhere: jest.fn().mockReturnValue({ execute: jest.fn().mockImplementation(async () => ({ affected: reserveAffected })) }) }) }) }) }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(async (payment) => payment),
    };
    paystack = { initiateRefund: jest.fn().mockResolvedValue({ id: 'refund-1' }) };
    provider = new RefundPaymentProvider(repo as any, paystack as any);
  });

  it('caps cumulative refunds at the captured balance', () => {
    expect(assertRefundWithinCaptured(10000, 7000, 3000)).toEqual({ nextRefunded: 10000n, remainingAfter: 0n });
    expect(() => assertRefundWithinCaptured(10000, 7000, 3001)).toThrow(BadRequestException);
  });

  it('submits exactly one provider refund and persists the cumulative amount', async () => {
    const result = await provider.refund(paymentId, 'user-1', UserRole.USER);
    expect(paystack.initiateRefund).toHaveBeenCalledTimes(1);
    expect(paystack.initiateRefund).toHaveBeenCalledWith('ref-1', 10000);
    expect(result.refundedAmount).toBe(10000);
    expect(result.status).toBe(PaymentStatus.REFUNDED);
  });

  it('supports partial refunds and checks subsequent balance', async () => {
    const first = await provider.refund(paymentId, 'user-1', UserRole.USER, 4000);
    expect(first.refundedAmount).toBe(4000);
    expect(first.status).toBe(PaymentStatus.SUCCESS);
    repo.findOne.mockResolvedValue({ ...first, status: PaymentStatus.SUCCESS });
    const second = await provider.refund(paymentId, 'user-1', UserRole.USER, 6000);
    expect(second.refundedAmount).toBe(10000);
    expect(second.status).toBe(PaymentStatus.REFUNDED);
  });

  it('rejects requests above the remaining captured balance before provider call', async () => {
    repo.findOne.mockResolvedValue({ id: paymentId, userId: 'user-1', status: PaymentStatus.SUCCESS, providerReference: 'ref-1', amount: 10000, refundedAmount: 9000 });
    await expect(provider.refund(paymentId, 'user-1', UserRole.USER, 1001)).rejects.toBeInstanceOf(BadRequestException);
    expect(paystack.initiateRefund).not.toHaveBeenCalled();
  });

  it('allows only one concurrent reservation', async () => {
    reserveAffected = 0;
    repo.createQueryBuilder = jest.fn().mockReturnValue({ update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ andWhere: jest.fn().mockReturnValue({ execute: jest.fn().mockResolvedValue({ affected: 0 }) }) }) }) }) });
    await expect(provider.refund(paymentId, 'user-1', UserRole.USER)).rejects.toBeInstanceOf(ConflictException);
    expect(paystack.initiateRefund).not.toHaveBeenCalled();
  });

  it('rolls reservation back when the provider fails', async () => {
    paystack.initiateRefund.mockRejectedValue(new Error('upstream'));
    await expect(provider.refund(paymentId, 'user-1', UserRole.USER)).rejects.toThrow('upstream');
    expect(repo.update).toHaveBeenCalledWith({ id: paymentId, status: PaymentStatus.REFUNDING }, { status: PaymentStatus.SUCCESS });
  });

  it('rejects already refunded payments', async () => {
    repo.findOne.mockResolvedValue({ id: paymentId, userId: 'user-1', status: PaymentStatus.REFUNDED, amount: 10000, refundedAmount: 10000 });
    await expect(provider.refund(paymentId, 'user-1', UserRole.USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(paystack.initiateRefund).not.toHaveBeenCalled();
  });
});
