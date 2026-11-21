import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as crypto from 'crypto';

const PAYSTACK_BASE = 'https://api.paystack.co';
const MAX_TRANSIENT_ATTEMPTS = 3;
const RETRY_DELAY_MS = 100;

function isTransientPaystackError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|econnreset|econnrefused|enotfound|network|socket hang up/i.test(message);
  }
  const status = error.response?.status;
  return status === undefined || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

@Injectable()
export class PaystackProvider {
  private readonly logger = new Logger(PaystackProvider.name);
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY');
    if (!secretKey || secretKey.trim() === '') throw new Error('PAYSTACK_SECRET_KEY environment variable is not defined');
    this.secretKey = secretKey;
  }

  private get headers() {
    return { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' };
  }

  private async withTransientRetries<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= MAX_TRANSIENT_ATTEMPTS || !isTransientPaystackError(error)) throw error;
        this.logger.warn(`Transient Paystack error; retrying attempt ${attempt + 1}/${MAX_TRANSIENT_ATTEMPTS}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)));
      }
    }
  }

  async initializeTransaction(email: string, amountKobo: number, reference: string, callbackUrl: string, metadata?: Record<string, unknown>): Promise<{ authorization_url: string; access_code: string; reference: string }> {
    const { data } = await this.withTransientRetries(() => axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email, amount: amountKobo, reference, callback_url: callbackUrl, metadata,
    }, { headers: this.headers }));
    return data.data;
  }

  async verifyTransaction(reference: string): Promise<Record<string, unknown>> {
    const { data } = await this.withTransientRetries(() => axios.get(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, { headers: this.headers }));
    return data.data as Record<string, unknown>;
  }

  async initiateRefund(transactionReference: string, amountKobo?: number): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = { transaction: transactionReference };
    if (amountKobo !== undefined) payload.amount = amountKobo;
    const { data } = await this.withTransientRetries(() => axios.post(`${PAYSTACK_BASE}/refund`, payload, { headers: this.headers }));
    return data.data as Record<string, unknown>;
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const hash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    if (typeof signature !== 'string' || signature.length !== hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  }
}
