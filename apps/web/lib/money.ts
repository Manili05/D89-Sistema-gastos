/**
 * Exact decimal math for expense lines, mirroring apps/api/app/services/expense_totals.py.
 * Uses BigInt fixed-point units (never floats) and ROUND_HALF_UP to cents, so what the
 * form shows is exactly what the server will compute and validate.
 */

const QTY_SCALE = 4n; // quantities and prices: up to 4 decimals (numeric(18,4))
const TEN = 10n;
const IVA_DIVISOR = 116n; // total / 1.16 → subtotal (IVA 16 % incluido)

export type LineDraft = {
  key: string;
  quantity: string;
  unit: string;
  description: string;
  unitPrice: string;
  discount: string;
  /** Gravable: its price includes 16 % IVA. Exempt lines contribute no IVA. */
  taxable: boolean;
};

/** Parse "1,234.5" / "1234.5" into integer units at `scale` decimals; null if invalid. */
export function toUnits(value: string, scale: bigint = QTY_SCALE): bigint | null {
  const text = value.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  if (BigInt(fraction.length) > scale) return null;
  return BigInt(whole + fraction.padEnd(Number(scale), '0'));
}

/** Round a non-negative value expressed in 10^-`from` units to 10^-`to` units, half up. */
function roundHalfUp(value: bigint, from: bigint, to: bigint): bigint {
  const factor = TEN ** (from - to);
  return (value * 2n + factor) / (factor * 2n);
}

/** Line amount in cents = round_half_up(quantity × price − discount); null if invalid. */
export function lineAmountCents(line: Pick<LineDraft, 'quantity' | 'unitPrice' | 'discount'>): bigint | null {
  const quantity = toUnits(line.quantity);
  const price = toUnits(line.unitPrice);
  const discount = line.discount.trim() === '' ? 0n : toUnits(line.discount);
  if (quantity === null || price === null || discount === null || quantity === 0n) return null;
  const gross = quantity * price; // 10^-8 units
  const net = gross - discount * TEN ** QTY_SCALE;
  if (net < 0n) return null; // discount exceeds quantity × price
  return roundHalfUp(net, QTY_SCALE * 2n, 2n);
}

/** IVA contained in a total whose price includes 16 %: total − round(total / 1.16). */
export function includedIvaCents(totalCents: bigint): bigint {
  return totalCents - subtotalFromTotal(totalCents);
}

function subtotalFromTotal(totalCents: bigint): bigint {
  // round_half_up(total / 1.16) in cents == floor((2·total·100 + 116) / (2·116))
  return (totalCents * 200n + IVA_DIVISOR) / (IVA_DIVISOR * 2n);
}

export type Totals = {
  lineCents: (bigint | null)[];
  valid: boolean;
  totalCents: bigint;
  ivaCents: bigint;
  subtotalCents: bigint;
  /** What to send as `iva`: null lets the server apply the 16 % default rule. */
  ivaForServer: string | null;
};

/**
 * Totals exactly as the backend computes them. With every line taxable and no explicit
 * IVA we send `iva: null` (server default rule); otherwise we send the IVA contained in
 * the taxable lines, which is always within the server's accepted range.
 */
export function computeTotals(lines: LineDraft[], explicitIvaCents: bigint | null = null): Totals {
  const lineCents = lines.map(lineAmountCents);
  const valid = lines.length > 0 && lineCents.every((value) => value !== null);
  const totalCents = lineCents.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
  let ivaCents: bigint;
  let ivaForServer: string | null;
  if (explicitIvaCents !== null) {
    ivaCents = explicitIvaCents;
    ivaForServer = formatCents(explicitIvaCents);
  } else if (lines.every((line) => line.taxable)) {
    ivaCents = includedIvaCents(totalCents);
    ivaForServer = null;
  } else {
    const taxableCents = lines.reduce<bigint>(
      (sum, line, index) => sum + (line.taxable ? (lineCents[index] ?? 0n) : 0n), 0n,
    );
    ivaCents = includedIvaCents(taxableCents);
    ivaForServer = formatCents(ivaCents);
  }
  return {
    lineCents, valid: valid && totalCents > 0n, totalCents, ivaCents,
    subtotalCents: totalCents - ivaCents, ivaForServer,
  };
}

/** Cents → "1234.56" (API string). */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** Cents → "$1,234.56" for display (safe: two decimals always fit a double exactly enough). */
export function displayCents(cents: bigint | null): string {
  return cents === null ? '—' : currency.format(Number(formatCents(cents)));
}

/** API decimal string ("1250.5000") → editable text without trailing zeros ("1250.5"). */
export function trimDecimal(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

let sequence = 0;
export function newLine(overrides: Partial<LineDraft> = {}): LineDraft {
  sequence += 1;
  return {
    key: `line-${sequence}`, quantity: '1', unit: 'pieza', description: '', unitPrice: '',
    discount: '', taxable: true, ...overrides,
  };
}

/** API decimal (up to 4 places, e.g. "1250.0050") → cents, rounded HALF_UP like the backend. */
export function centsFromDecimal(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const units = toUnits(trimDecimal(value).replace(/,/g, ''));
  if (units === null) return null;
  return (units + 50n) / 100n; // 10^-4 → 10^-2, half up for non-negative amounts
}
