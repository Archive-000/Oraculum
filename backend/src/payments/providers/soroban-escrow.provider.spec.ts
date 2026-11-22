import { ConfigService } from '@nestjs/config';
import { EscrowOutcomeStatus, SorobanEscrowProvider } from './soroban-escrow.provider';

describe('SorobanEscrowProvider', () => {
  const configValues: Record<string, string> = { PAYMENT_ESCROW_CONTRACT_ID: 'CESCROW123', STELLAR_NETWORK: 'testnet', STELLAR_RPC_URL: 'https://rpc.example.test' };
  function createProvider() {
    const configService = { get: jest.fn((key: string, fallback?: unknown) => configValues[key] ?? fallback) } as unknown as ConfigService;
    return { provider: new SorobanEscrowProvider(configService), configService };
  }

  it('loads Soroban configuration', () => {
    const { configService } = createProvider();
    expect(configService.get).toHaveBeenNthCalledWith(1, 'PAYMENT_ESCROW_CONTRACT_ID', '');
    expect(configService.get).toHaveBeenNthCalledWith(2, 'STELLAR_NETWORK', 'testnet');
    expect(configService.get).toHaveBeenNthCalledWith(3, 'STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
  });

  it('returns deterministic create hash', async () => {
    const { provider } = createProvider();
    await expect(provider.createEscrow('booking-123', 'G depositor', 'G beneficiary', 25000, 'Booking', 1750000000)).resolves.toBe('soroban_stub_booking-123');
  });

  it.each([
    ['releaseEscrow', 'soroban_release_stub_booking-123'],
    ['refundEscrow', 'soroban_refund_stub_booking-123'],
  ])('reuses the successful %s result on retry', async (method, expected) => {
    const { provider } = createProvider();
    const call = method === 'releaseEscrow' ? provider.releaseEscrow.bind(provider) : provider.refundEscrow.bind(provider);
    const [first, second] = await Promise.all([call('booking-123'), call('booking-123')]);
    expect(first).toBe(expected);
    expect(second).toBe(expected);
    await expect(call('booking-123')).resolves.toBe(expected);
  });

  it('does not share release and refund results', async () => {
    const { provider } = createProvider();
    await expect(provider.releaseEscrow('e1')).resolves.toBe('soroban_release_stub_e1');
    await expect(provider.refundEscrow('e1')).resolves.toBe('soroban_refund_stub_e1');
  });

  it('returns current escrow status', async () => {
    const { provider } = createProvider();
    await expect(provider.getEscrowStatus('e1')).resolves.toEqual({ escrowId: 'e1', status: 'stub' });
  });

  describe('reconcileEscrow', () => {
    it('keeps stub status pending', async () => {
      const { provider } = createProvider();
      await expect(provider.reconcileEscrow('e1')).resolves.toMatchObject({ status: EscrowOutcomeStatus.PENDING, final: false, retryable: true });
    });
    it.each([
      ['confirmed', EscrowOutcomeStatus.CONFIRMED, true, false],
      ['failed', EscrowOutcomeStatus.FAILED, true, false],
      ['timed_out', EscrowOutcomeStatus.TIMED_OUT, false, true],
    ])('maps %s', async (status, expected, final, retryable) => {
      const { provider } = createProvider();
      jest.spyOn(provider, 'getEscrowStatus').mockResolvedValue({ status });
      await expect(provider.reconcileEscrow('e1')).resolves.toMatchObject({ status: expected, final, retryable });
    });
    it('treats transient RPC errors as retryable', async () => {
      const { provider } = createProvider();
      jest.spyOn(provider, 'getEscrowStatus').mockRejectedValue(new Error('503 Service Unavailable'));
      await expect(provider.reconcileEscrow('e1')).resolves.toMatchObject({ status: EscrowOutcomeStatus.PENDING, final: false, retryable: true });
    });
    it('treats permanent RPC errors as final failures', async () => {
      const { provider } = createProvider();
      jest.spyOn(provider, 'getEscrowStatus').mockRejectedValue(new Error('contract trapped'));
      await expect(provider.reconcileEscrow('e1')).resolves.toMatchObject({ status: EscrowOutcomeStatus.FAILED, final: true, retryable: false });
    });
  });
});
