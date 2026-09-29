'use client';

import { useCallback, useEffect, useState } from 'react';
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
    {showForm && <IncomeForm workId={workId} onCancel={() => { setShowForm(false); void load(); }}
      onSaved={(_income, text) => { setShowForm(false); setMessage(text); void load(); }} />}
    <section className="panel" aria-label="Ingresos de la obra">
      <div className="panel-header">
        <div><h2>Ingresos de la obra</h2><p>{items ? `${items.length} ingreso${items.length === 1 ? '' : 's'} registrado${items.length === 1 ? '' : 's'}` : 'Cargando…'}</p></div>
        {canManage && !showForm && <button type="button" className="btn" onClick={() => { setMessage(''); setShowForm(true); }}><PlusIcon />Nuevo ingreso</button>}
      </div>
      {items && <dl className="income-summary">
        <div><dt>Total cobrado</dt><dd data-testid="income-total">{displayCents(sum())}</dd></div>
        <div><dt>Pendiente de conciliar</dt><dd data-testid="income-pending">{displayCents(sum('pendiente'))}</dd></div>
        <div><dt>Conciliado</dt><dd data-testid="income-reconciled">{displayCents(sum('conciliado'))}</dd></div>
      </dl>}
      {items ? <IncomeTable items={items} /> : !error && <p role="status">Cargando ingresos…</p>}
    </section>
  </>;
}
