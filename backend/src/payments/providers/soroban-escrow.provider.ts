import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export enum EscrowOutcomeStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  TIMED_OUT = 'timed_out',
}
export interface EscrowOutcome {
  escrowId: string;
  status: EscrowOutcomeStatus;
  final: boolean;
  retryable: boolean;
  reason?: string;
}
const TRANSIENT_ERROR_PATTERN =
  /timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|network|rate limit|too many requests|\b(429|500|502|503|504)\b|try_again_later|unavailable/i;
export function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_ERROR_PATTERN.test(message);
}

@Injectable()
export class SorobanEscrowProvider {
  private readonly logger = new Logger(SorobanEscrowProvider.name);
  private readonly contractId: string;
  private readonly network: string;
  private readonly rpcUrl: string;
  // Keep both completed results and in-flight submissions. A successful
  // settlement is never submitted again during this provider's lifetime.
  private readonly settlements = new Map<string, string>();
  private readonly settlementRequests = new Map<string, Promise<string>>();

  constructor(private readonly configService: ConfigService) {
    this.contractId = this.configService.get<string>('PAYMENT_ESCROW_CONTRACT_ID', '');
    this.network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');
    this.rpcUrl = this.configService.get<string>('STELLAR_RPC_URL', 'https://soroban-testnet.stellar.org');
  }

  async createEscrow(
    escrowId: string, depositorAddress: string, beneficiaryAddress: string,
    amountKobo: number, description: string, releaseAfterUnix: number,
  ): Promise<string> {
    this.logger.log(`[Soroban] createEscrow: ${escrowId} — ${amountKobo} kobo — release after ${releaseAfterUnix}`);
    return `soroban_stub_${escrowId}`;
  }

  private settle(escrowId: string, operation: 'release' | 'refund'): Promise<string> {
    const key = `${operation}:${escrowId}`;
    const stored = this.settlements.get(key);
    if (stored) return Promise.resolve(stored);
    const pending = this.settlementRequests.get(key);
    if (pending) return pending;

    const request = Promise.resolve().then(() => {
      this.logger.log(`[Soroban] ${operation}Escrow: ${escrowId}`);
      // Replace this deterministic adapter with the Soroban SDK submission.
      return `soroban_${operation}_stub_${escrowId}`;
    }).then((result) => {
      this.settlements.set(key, result);
      return result;
    }).finally(() => {
      this.settlementRequests.delete(key);
    });
    this.settlementRequests.set(key, request);
    return request;
  }

  releaseEscrow(escrowId: string): Promise<string> {
    return this.settle(escrowId, 'release');
  }

  refundEscrow(escrowId: string): Promise<string> {
    return this.settle(escrowId, 'refund');
  }

  async getEscrowStatus(escrowId: string): Promise<Record<string, unknown>> {
    this.logger.log(`[Soroban] getEscrowStatus: ${escrowId}`);
    return { escrowId, status: 'stub' };
  }

  normalizeOutcome(escrowId: string, raw: Record<string, unknown>): EscrowOutcome {
    const value = String(raw?.status ?? '').toLowerCase();
    switch (value) {
      case 'confirmed': case 'success': case 'released': case 'refunded':
        return { escrowId, status: EscrowOutcomeStatus.CONFIRMED, final: true, retryable: false };
      case 'failed': case 'error':
        return { escrowId, status: EscrowOutcomeStatus.FAILED, final: true, retryable: false, reason: raw?.reason ? String(raw.reason) : undefined };
      case 'timed_out': case 'timeout':
        return { escrowId, status: EscrowOutcomeStatus.TIMED_OUT, final: false, retryable: true };
      default:
        return { escrowId, status: EscrowOutcomeStatus.PENDING, final: false, retryable: true };
    }
  }

  async reconcileEscrow(escrowId: string): Promise<EscrowOutcome> {
    try {
      return this.normalizeOutcome(escrowId, await this.getEscrowStatus(escrowId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isTransientRpcError(error)) {
        this.logger.warn(`[Soroban] transient RPC failure for ${escrowId}: ${reason}`);
        return { escrowId, status: EscrowOutcomeStatus.PENDING, final: false, retryable: true, reason };
      }
      this.logger.error(`[Soroban] escrow ${escrowId} failed: ${reason}`);
      return { escrowId, status: EscrowOutcomeStatus.FAILED, final: true, retryable: false, reason };
    }
  }
}
