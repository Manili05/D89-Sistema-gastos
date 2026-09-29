import type { components } from '@/lib/api.generated';

export type IncomeResponse = components['schemas']['IncomeResponse'];

export const RECEIPT_KIND_LABEL: Record<string, string> = { pdf: 'PDF', xml: 'XML', imagen: 'Imagen' };

const dateTime = new Intl.DateTimeFormat('es-MX', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Mexico_City',
});

export function formatDateTime(value?: string | null): string {
  return value ? dateTime.format(new Date(value)) : '';
}

/** "Sergio Gómez · 21 sep 2026, 9:30 a.m." for a reconciled income, '' otherwise. */
export function reconciledBy(income: IncomeResponse): string {
  if (income.state !== 'conciliado') return '';
  return [income.reconciled_by, formatDateTime(income.reconciled_at)].filter(Boolean).join(' · ');
}
