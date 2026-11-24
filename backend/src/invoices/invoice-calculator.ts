export interface InvoiceLineItem {
  description: string;
  unitAmountCents: number;
  quantity: number;
  /** Overrides the invoice-wide tax rate for this line when supplied. */
  taxRatePercent?: number;
}

export interface DiscountConfig {
  type: 'PERCENTAGE' | 'FIXED_AMOUNT';
  value: number; // Percentage (e.g., 15 for 15%) or Cents (e.g., 1000 for $10.00)
}

export interface InvoiceCalculationInput {
  lineItems: InvoiceLineItem[];
  discount?: DiscountConfig;
  taxRatePercent?: number; // Default tax rate; line-level rates take precedence.
  prorationFactor?: number; // e.g. 0.5 for 50% partial billing duration
}

export interface InvoiceCalculationResult {
  subtotalCents: number;
  proratedSubtotalCents: number;
  discountCents: number;
  taxableAmountCents: number;
  taxCents: number;
  totalCents: number;
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite, non-negative number`);
  }
  return value;
}

/**
 * Splits a discount over line totals in proportion to their value. Flooring
 * each share first and distributing the remaining cents by largest remainder
 * guarantees that line allocations add up to the exact invoice discount.
 */
function allocateDiscount(discountCents: number, lineTotals: number[]): number[] {
  const subtotal = lineTotals.reduce((sum, value) => sum + value, 0);
  if (discountCents === 0 || subtotal === 0) return lineTotals.map(() => 0);

  const allocations = lineTotals.map((value) =>
    Math.floor((discountCents * value) / subtotal),
  );
  let remaining = discountCents - allocations.reduce((sum, value) => sum + value, 0);
  const remainders = lineTotals
    .map((value, index) => ({
      index,
      remainder: (discountCents * value) % subtotal,
    }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const entry of remainders) {
    if (remaining === 0) break;
    if (allocations[entry.index] < lineTotals[entry.index]) {
      allocations[entry.index] += 1;
      remaining -= 1;
    }
  }
  return allocations;
}

export class InvoiceCalculator {
  /**
   * Calculates each normalized line in cents before aggregating the invoice.
   * This keeps fractional quantities and mixed tax rates consistent with the
   * displayed line items instead of applying one tax rate to the whole bill.
   */
  static calculate(input: InvoiceCalculationInput): InvoiceCalculationResult {
    const { lineItems, discount, taxRatePercent = 0, prorationFactor = 1.0 } = input;
    const defaultTaxRate = requireFiniteNonNegative(taxRatePercent, 'taxRatePercent');
    const factor = requireFiniteNonNegative(prorationFactor, 'prorationFactor');

    const lineSubtotals = lineItems.map((item) => {
      if (!Number.isSafeInteger(item.unitAmountCents) || item.unitAmountCents < 0) {
        throw new RangeError('unitAmountCents must be a non-negative safe integer');
      }
      const quantity = requireFiniteNonNegative(item.quantity, 'quantity');
      const lineTotal = Math.round(item.unitAmountCents * quantity);
      if (!Number.isSafeInteger(lineTotal)) {
        throw new RangeError('line total must be a safe integer number of cents');
      }
      return lineTotal;
    });

    const subtotalCents = lineSubtotals.reduce((sum, value) => sum + value, 0);
    const proratedLines = lineSubtotals.map((value) =>
      Math.max(0, Math.round(value * factor)),
    );
    const proratedSubtotalCents = proratedLines.reduce((sum, value) => sum + value, 0);

    let discountCents = 0;
    if (discount) {
      const discountValue = requireFiniteNonNegative(discount.value, 'discount.value');
      if (discount.type === 'PERCENTAGE') {
        discountCents = Math.round(
          (proratedSubtotalCents * Math.min(100, discountValue)) / 100,
        );
      } else if (discount.type === 'FIXED_AMOUNT') {
        discountCents = Math.round(discountValue);
      }
    }
    discountCents = Math.min(proratedSubtotalCents, discountCents);

    const lineDiscounts = allocateDiscount(discountCents, proratedLines);
    const taxableLines = proratedLines.map((line, index) => line - lineDiscounts[index]);
    const taxableAmountCents = taxableLines.reduce((sum, value) => sum + value, 0);

    const taxCents = taxableLines.reduce((sum, taxableLine, index) => {
      const configuredRate = lineItems[index].taxRatePercent;
      const rate =
        configuredRate === undefined
          ? defaultTaxRate
          : requireFiniteNonNegative(configuredRate, 'line taxRatePercent');
      return sum + Math.round((taxableLine * rate) / 100);
    }, 0);

    return {
      subtotalCents,
      proratedSubtotalCents,
      discountCents,
      taxableAmountCents,
      taxCents,
      totalCents: taxableAmountCents + taxCents,
    };
  }
}
