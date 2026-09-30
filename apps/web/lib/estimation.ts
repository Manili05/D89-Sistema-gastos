/**
 * Live estimation math, mirroring apps/api/app/services/estimation_totals.py and the
 * balance rules of repository._check_estimation. BigInt cents, ROUND_HALF_UP: what the
 * form shows is exactly what the server will store (it recomputes and validates).
 *
 *   neto = bruto + aditivas − deductivas − retención − amortización
 */
import type { components } from '@/lib/api.generated';
import { centsFromDecimal, toUnits, trimDecimal } from '@/lib/money';

export type Subcontract = components['schemas']['SubcontractResponse'];
export type Estimation = components['schemas']['EstimationResponse'];
export type EstimationKind = Estimation['kind'];

export const KIND_LABEL: Record<EstimationKind, string> = {
  anticipo: 'Anticipo', avance: 'Avance', finiquito: 'Finiquito',
};

export type EstimationDraft = {
  kind: EstimationKind; gross: string; amortization: string; additions: string;
  deductions: string; notes: string;
};

/** Money input: up to 2 decimals, "1,234.5" accepted; '' counts as 0 for optional fields. */
export function moneyCents(value: string, optional = true): bigint | null {
  if (!value.trim()) return optional ? 0n : null;
  return toUnits(value, 2n);
}

const cents = (value: string | number | null | undefined) => centsFromDecimal(value) ?? 0n;

/** Retention in cents: gross × percent / 100, half up (0 for an anticipo). */
export function retentionCents(kind: EstimationKind, grossCents: bigint, percent: string | number): bigint {
  if (kind === 'anticipo') return 0n;
  const hundredths = toUnits(trimDecimal(percent) || '0', 2n) ?? 0n; // 5.25 % → 525
  return (grossCents * hundredths + 5000n) / 10000n;
}

/** Balances the server checks, from the contract and its other estimations. */
export function balances(contract: Subcontract, estimations: Estimation[], excludeId?: string) {
  const others = estimations.filter((item) => item.id !== excludeId);
  const sum = (items: Estimation[], pick: (item: Estimation) => bigint) =>
    items.reduce((total, item) => total + pick(item), 0n);
  const advancesPaid = sum(others.filter((item) => item.kind === 'anticipo' && item.state === 'pagado'), (item) => cents(item.gross_amount));
  const amortized = sum(others, (item) => cents(item.advance_amortization));
  return {
    contracted: cents(contract.contracted_amount),
    grossEstimated: sum(others.filter((item) => item.kind !== 'anticipo'), (item) => cents(item.gross_amount)),
    advances: sum(others.filter((item) => item.kind === 'anticipo'), (item) => cents(item.gross_amount)),
    amortizable: advancesPaid - amortized,
    hasFiniquito: others.some((item) => item.kind === 'finiquito'),
  };
}

export type EstimationPreview = {
  gross: bigint | null; additions: bigint | null; deductions: bigint | null;
  amortization: bigint | null; retention: bigint; net: bigint | null; errors: string[];
};

export function previewEstimation(
  draft: EstimationDraft, contract: Subcontract, estimations: Estimation[], excludeId?: string,
): EstimationPreview {
  const gross = moneyCents(draft.gross, false);
  const additions = moneyCents(draft.additions);
  const deductions = moneyCents(draft.deductions);
  const amortization = moneyCents(draft.amortization);
  const errors: string[] = [];
  if (gross === null || gross <= 0n) errors.push('Captura un importe bruto mayor que cero (hasta 2 decimales).');
  if (additions === null || deductions === null || amortization === null) errors.push('Los importes admiten hasta 2 decimales.');
  const retention = gross && gross > 0n ? retentionCents(draft.kind, gross, contract.retention_percent) : 0n;
  const net = gross !== null && additions !== null && deductions !== null && amortization !== null
    ? gross + additions - deductions - retention - amortization : null;
  const b = balances(contract, estimations, excludeId);
  if (draft.kind === 'anticipo' && ((amortization ?? 0n) || (additions ?? 0n) || (deductions ?? 0n))) {
    errors.push('Un anticipo se paga íntegro: sin amortización, aditivas ni deductivas.');
  }
  if (gross && gross > 0n) {
    if (draft.kind === 'anticipo' && b.advances + gross > b.contracted) errors.push('Los anticipos exceden el importe contratado.');
    if (draft.kind !== 'anticipo' && b.grossEstimated + gross > b.contracted) {
      errors.push('El bruto excede lo que queda por estimar del contrato; los trabajos extra van como aditivas.');
    }
  }
  if (amortization !== null && amortization > b.amortizable) errors.push('La amortización excede el anticipo pagado pendiente de amortizar.');
  if (draft.kind === 'finiquito' && amortization !== null && amortization !== b.amortizable) {
    errors.push('El finiquito debe amortizar todo el anticipo pendiente.');
  }
  if (draft.kind === 'finiquito' && b.hasFiniquito) errors.push('El subcontrato ya tiene finiquito.');
  if (((additions ?? 0n) > 0n || (deductions ?? 0n) > 0n) && draft.notes.trim().length < 5) {
    errors.push('Justifica las aditivas o deductivas en notas (mínimo 5 caracteres).');
  }
  if (net !== null && net < 0n) errors.push('El importe neto no puede ser negativo.');
  return { gross, additions, deductions, amortization, retention, net, errors };
}
