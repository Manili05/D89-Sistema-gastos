'use client';

import { useCallback, useEffect, useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import type { components } from '@/lib/api.generated';
import { apiJson } from '@/lib/auth';
import { centsFromDecimal, displayCents } from '@/lib/money';
import { openSignedReceipt, receiptFileName } from '@/lib/receipts';

type IncomeResponse = components['schemas']['IncomeResponse'];

const dateTime = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });

export function formatReconciledAt(value?: string | null): string {
  return value ? dateTime.format(new Date(value)) : '';
}

/**
 * "Conciliar ingresos" view of Validación. Mirrors expense validation: a stored
 * receipt is required (the API enforces it too), per-row and batch actions, and a
 * reconciled income can be reverted only with a written reason.
 */
export function IncomeReconcilePanel({ workId, canManage }: { workId: string; canManage: boolean }) {
  const [items, setItems] = useState<IncomeResponse[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [reverting, setReverting] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await apiJson<IncomeResponse[]>(`/works/${workId}/incomes`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar los ingresos.');
    }
  }, [workId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await action();
      setMessage(success);
      setSelected([]); setReverting(null); setReason('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible actualizar el ingreso.');
    } finally {
      setBusy(false);
    }
  }

  const reconcileOne = (income: IncomeResponse) => run(() => apiJson(`/incomes/${income.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ state: 'conciliado' }),
  }), `Ingreso ${income.folio} conciliado.`);
  const reconcileSelected = () => run(() => apiJson('/incomes/reconcile-batch', {
    method: 'POST', body: JSON.stringify({ work_id: workId, income_ids: selected }),
  }), `${selected.length} ingreso${selected.length === 1 ? '' : 's'} conciliado${selected.length === 1 ? '' : 's'}.`);
  const revert = (income: IncomeResponse) => run(() => apiJson(`/incomes/${income.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ state: 'pendiente', reason: reason.trim() }),
  }), `Conciliación del ingreso ${income.folio} revertida.`);

  async function open(path: string) {
    setError('');
    try { await openSignedReceipt(path, false); } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible abrir el comprobante.');
    }
  }

  const pending = (items || []).filter((income) => income.state === 'pendiente');
  const reconciled = (items || []).filter((income) => income.state === 'conciliado');
  const hasReceipt = (income: IncomeResponse) => (income.receipts || []).length > 0;

  const receiptsCell = (income: IncomeResponse) => hasReceipt(income)
    ? <ul className="income-receipts">{(income.receipts || []).map((receipt) => {
      const name = receiptFileName(receipt.path);
      return <li key={receipt.id}><span className="income-receipt-name">{name}</span><button type="button" className="text-action" aria-label={`Ver ${name} del ingreso ${income.folio}`} onClick={() => void open(receipt.path)}>Ver</button></li>;
    })}</ul>
    : <><span className="missing-receipt">Faltante</span><small>Adjunta un comprobante en Ingresos</small></>;

  return <section className="panel" aria-label="Conciliar ingresos">
    <div className="panel-header">
      <div><h2>Ingresos pendientes de conciliar</h2><p>Confirma contra el estado de cuenta; el comprobante es obligatorio</p></div>
      {canManage && <button type="button" className="btn" disabled={!selected.length || busy} onClick={() => void reconcileSelected()}>Conciliar seleccionados ({selected.length})</button>}
    </div>
    {message && <p className="notice success panel-notice" role="status">{message}</p>}
    {error && <p className="notice error panel-notice" role="alert">{error}</p>}
    {!items && !error && <p className="empty-state" role="status">Cargando ingresos…</p>}
    {items && <div className="expense-table-wrap"><table className="expense-table reconcile-table" role="table">
      <caption className="sr-only">Ingresos pendientes de conciliar</caption>
      <thead role="rowgroup"><tr role="row">{canManage && <th role="columnheader" scope="col"><span className="sr-only">Seleccionar</span></th>}<th role="columnheader" scope="col">Folio / concepto</th><th role="columnheader" scope="col">Fecha</th><th role="columnheader" scope="col">Importe</th><th role="columnheader" scope="col">Comprobantes</th>{canManage && <th role="columnheader" scope="col">Acciones</th>}</tr></thead>
      <tbody role="rowgroup">{pending.map((income) => <tr role="row" key={income.id}>
        {canManage && <td role="cell"><input type="checkbox" aria-label={`Seleccionar ingreso ${income.folio}`} checked={selected.includes(income.id)} disabled={!hasReceipt(income) || busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, income.id] : current.filter((id) => id !== income.id))} /></td>}
        <td role="cell" data-label="Folio / concepto"><strong>{income.folio}</strong><small>{income.concept}</small>{income.reversal_reason && <small className="reversal-note">Revertido: {income.reversal_reason}</small>}</td>
        <td role="cell" data-label="Fecha">{income.received_on}</td>
        <td role="cell" data-label="Importe"><strong>{displayCents(centsFromDecimal(income.amount))}</strong></td>
        <td role="cell" data-label="Comprobantes">{receiptsCell(income)}</td>
        {canManage && <td role="cell"><button type="button" className="text-action" disabled={!hasReceipt(income) || busy} title={hasReceipt(income) ? undefined : 'Adjunta un comprobante en Ingresos'} aria-label={`Conciliar ingreso ${income.folio}`} onClick={() => void reconcileOne(income)}>Conciliar</button></td>}
      </tr>)}</tbody>
    </table>{pending.length === 0 && <p className="empty-state">No hay ingresos pendientes de conciliar.</p>}</div>}

    {items && reconciled.length > 0 && <>
      <div className="panel-header subheader"><div><h3>Conciliados</h3><p>Revertir exige un motivo y queda en la bitácora</p></div></div>
      <div className="expense-table-wrap"><table className="expense-table reconcile-table" role="table">
        <caption className="sr-only">Ingresos conciliados</caption>
        <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Folio / concepto</th><th role="columnheader" scope="col">Importe</th><th role="columnheader" scope="col">Conciliación</th>{canManage && <th role="columnheader" scope="col">Acciones</th>}</tr></thead>
        <tbody role="rowgroup">{reconciled.map((income) => <tr role="row" key={income.id}>
          <td role="cell" data-label="Folio / concepto"><strong>{income.folio}</strong><small>{income.concept}</small></td>
          <td role="cell" data-label="Importe"><strong>{displayCents(centsFromDecimal(income.amount))}</strong></td>
          <td role="cell" data-label="Conciliación"><StatusPill tone="green">Conciliado</StatusPill><small>{[income.reconciled_by, formatReconciledAt(income.reconciled_at)].filter(Boolean).join(' · ')}</small></td>
          {canManage && <td role="cell">{reverting === income.id
            ? <form className="revert-form" onSubmit={(event) => { event.preventDefault(); void revert(income); }}>
              <label className="field">Motivo de la reversión<input autoFocus value={reason} minLength={5} maxLength={500} placeholder="Ej. depósito duplicado" onChange={(event) => setReason(event.target.value)} required /></label>
              <div className="header-actions">
                <button type="button" className="btn secondary" disabled={busy} onClick={() => { setReverting(null); setReason(''); }}>Cancelar</button>
                <button type="submit" className="btn danger" disabled={busy || reason.trim().length < 5}>Confirmar reversión</button>
              </div>
            </form>
            : <button type="button" className="text-action danger" disabled={busy} aria-label={`Revertir conciliación del ingreso ${income.folio}`} onClick={() => { setReverting(income.id); setReason(''); }}>Revertir</button>}</td>}
        </tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
