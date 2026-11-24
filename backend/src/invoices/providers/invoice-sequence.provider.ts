import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Name of the PostgreSQL sequence backing `Invoice.invoiceNumber`. */
export const INVOICE_NUMBER_SEQUENCE = 'invoice_number_seq';

/** Prefix used to render a sequence value as a human-readable number. */
export const INVOICE_NUMBER_PREFIX = 'INV-';

/** Number of digits the rendered invoice number is zero-padded to. */
export const INVOICE_NUMBER_PAD = 5;

/** PostgreSQL SQLSTATE for `unique_violation`. */
export const UNIQUE_VIOLATION = '23505';

/**
 * BE-51 — Render a raw sequence value as an invoice number.
 * Exported so the formatting contract is unit-testable in isolation.
 */
export function formatInvoiceNumber(sequenceValue: unknown): string {
  if (
    sequenceValue === null ||
    sequenceValue === undefined ||
    sequenceValue === ''
  ) {
    throw new Error(
      `invoice_number_seq returned a non-usable value: ${String(sequenceValue)}`,
    );
  }

  const value = Number(sequenceValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `invoice_number_seq returned a non-usable value: ${String(sequenceValue)}`,
    );
  }
  return `${INVOICE_NUMBER_PREFIX}${String(value).padStart(
    INVOICE_NUMBER_PAD,
    '0',
  )}`;
}

/**
 * BE-51 — Does this error mean "the invoice number I just generated is
 * already taken"? Matching on SQLSTATE is more reliable than matching
 * driver-specific error messages.
 */
export function isInvoiceNumberCollision(
  error: unknown,
  constraint?: string,
): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as {
    code?: unknown;
    constraint?: unknown;
    message?: unknown;
  };

  if (constraint && err.constraint && err.constraint !== constraint) {
    return false;
  }
  if (err.code === UNIQUE_VIOLATION) return true;

  return (
    typeof err.message === 'string' &&
    err.message.toLowerCase().includes('duplicate key')
  );
}

@Injectable()
export class InvoiceSequenceProvider implements OnApplicationBootstrap {
  private readonly logger = new Logger(InvoiceSequenceProvider.name);
  private ensured = false;
  /** Shares one in-flight initialization among callers in this process. */
  private ensurePromise: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureSequence();
  }

  /**
   * Initialize and align the sequence once. The transaction-scoped advisory
   * lock also serializes initialization across application instances, so a
   * late setval from another boot cannot rewind values already handed out.
   */
  async ensureSequence(): Promise<void> {
    if (this.ensured) return;
    if (!this.ensurePromise) {
      this.ensurePromise = this.initializeSequence().finally(() => {
        this.ensurePromise = null;
      });
    }
    await this.ensurePromise;
  }

  private async initializeSequence(): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [INVOICE_NUMBER_SEQUENCE],
        );
        await manager.query(
          `CREATE SEQUENCE IF NOT EXISTS ${INVOICE_NUMBER_SEQUENCE} START 1`,
        );
        await manager.query(
          `SELECT setval(
             '${INVOICE_NUMBER_SEQUENCE}',
             GREATEST(
               (SELECT last_value FROM ${INVOICE_NUMBER_SEQUENCE}),
               (SELECT COALESCE(MAX(NULLIF(substring("invoiceNumber" from '[0-9]+$'), '')::bigint), 0) FROM invoices)
             ),
             true
           )`,
        );
      });
      this.ensured = true;
      this.logger.log(`${INVOICE_NUMBER_SEQUENCE} sequence ensured`);
    } catch (err) {
      // Bootstrap is best-effort — a read-only replica or a database
      // without DDL rights must not stop the app from booting.
      this.logger.error(
        `Failed to ensure ${INVOICE_NUMBER_SEQUENCE}: ${(err as Error).message}`,
      );
    }
  }

  /** Allocate a value with PostgreSQL's atomic, non-transactional nextval(). */
  async nextInvoiceNumber(): Promise<string> {
    if (!this.ensured) {
      await this.ensureSequence();
    }

    const result = await this.dataSource.query<{ nextval: string }[]>(
      `SELECT nextval('${INVOICE_NUMBER_SEQUENCE}')`,
    );
    const row = Array.isArray(result) ? result[0] : result;
    return formatInvoiceNumber(row?.nextval);
  }
}
