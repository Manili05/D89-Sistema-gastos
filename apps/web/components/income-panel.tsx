'use client';

import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { CASHFLOW_COLORS } from '@/components/cashflow-chart';
import { PlusIcon } from '@/components/icons';
import { IncomeForm } from '@/components/income-form';
import { IncomeTable } from '@/components/income-table';
import type { components } from '@/lib/api.generated';
import { apiJson } from '@/lib/auth';
import { centsFromDecimal, displayCents } from '@/lib/money';

type IncomeResponse = components['schemas']['IncomeResponse'];

/** "Ingresos" tab of a work: cash-in summary, list and (admin) registration. */
export function IncomePanel({ workId, canManage }: { workId: string; canManage: boolean }) {
  const [items, setItems] = useState<IncomeResponse[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await apiJson<IncomeResponse[]>(`/works/${workId}/incomes`));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar los ingresos.');
    }
  }, [workId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const sum = (state?: string) => (items || [])
    .filter((item) => !state || item.state === state)
    .reduce((total, item) => total + (centsFromDecimal(item.amount) ?? 0n), 0n);

  return <>
    {message && <p className="notice success" role="status">{message}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {items && <section className="metrics income-panel-metrics" aria-label="Resumen de ingresos">
      <article className="metric-card" style={{ '--accent': '#17233c' } as CSSProperties}><span className="metric-label">Total cobrado</span><strong className="metric-value" data-testid="income-total">{displayCents(sum())}</strong><span className="metric-foot">{items.length} ingreso{items.length === 1 ? '' : 's'}</span></article>
      <article className="metric-card" style={{ '--accent': CASHFLOW_COLORS.reconciled } as CSSProperties}><span className="metric-label">Conciliado</span><strong className="metric-value" data-testid="income-reconciled">{displayCents(sum('conciliado'))}</strong><span className="metric-foot">Confirmado contra comprobante</span></article>
      <article className="metric-card" style={{ '--accent': '#b78027' } as CSSProperties}><span className="metric-label">Pendiente de conciliar</span><strong className="metric-value" data-testid="income-pending">{displayCents(sum('pendiente'))}</strong><span className="metric-foot">Se concilia en Validación</span></article>
    </section>}
    {showForm && <IncomeForm workId={workId} onCancel={() => { setShowForm(false); void load(); }}
      onSaved={(_income, text) => { setShowForm(false); setMessage(text); void load(); }} />}
    <section className="panel" aria-label="Ingresos de la obra">
      <div className="panel-header">
        <div><h2>Ingresos de la obra</h2><p>{items ? `${items.length} ingreso${items.length === 1 ? '' : 's'} registrado${items.length === 1 ? '' : 's'}` : 'Cargando…'}</p></div>
        {canManage && !showForm && <button type="button" className="btn" onClick={() => { setMessage(''); setShowForm(true); }}><PlusIcon />Nuevo ingreso</button>}
      </div>
      {items ? <IncomeTable items={items} onCreate={canManage && !showForm ? () => { setMessage(''); setShowForm(true); } : undefined} /> : !error && <p className="empty-state" role="status">Cargando ingresos…</p>}
    </section>
  </>;
}
