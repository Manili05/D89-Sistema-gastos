'use client';

import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { EstimationForm } from '@/components/estimation-form';
import { PlusIcon } from '@/components/icons';
import { StatusPill } from '@/components/status-pill';
import { SUBCONTRACT_STATE } from '@/components/subcontract-table';
import { apiFetch, apiJson } from '@/lib/auth';
import { type Estimation, KIND_LABEL, type Subcontract } from '@/lib/estimation';
import { formatDateTime } from '@/lib/incomes';
import { centsFromDecimal, displayCents } from '@/lib/money';

const money = (value: string | number) => displayCents(centsFromDecimal(value));

/** Download the server-generated PDF receipt of one estimation. */
async function downloadReceipt(contract: Subcontract, estimation: Estimation) {
  const response = await apiFetch(`/subcontracts/${contract.id}/estimations/${estimation.id}/receipt.pdf`);
  if (!response.ok) throw new Error('No fue posible generar el recibo.');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `recibo-${contract.folio}-${estimation.folio}.pdf`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Financial summary of one subcontract (contracted vs paid vs retained) and its
 * estimation history. Administration registers, corrects, deletes (drafts) and pays;
 * everyone with access can download receipts.
 */
export function SubcontractDetail({ subcontractId, canManage, onChanged, onClose, onEdit }: {
  subcontractId: string;
  canManage: boolean;
  onChanged: () => void;
  onClose: () => void;
  onEdit?: (contract: Subcontract) => void;
}) {
  const [contract, setContract] = useState<Subcontract | null>(null);
  const [form, setForm] = useState<{ estimation?: Estimation } | null>(null);
  const [confirming, setConfirming] = useState<{ id: string; action: 'pay' | 'delete' } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setContract(await apiJson<Subcontract>(`/subcontracts/${subcontractId}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar el subcontrato.');
    }
  }, [subcontractId]);

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
      setConfirming(null); setCancelling(false);
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible completar la operación.');
    } finally {
      setBusy(false);
    }
  }

  async function receipt(estimation: Estimation) {
    setError('');
    try { await downloadReceipt(contract!, estimation); } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible generar el recibo.');
    }
  }

  if (!contract) {
    return <section className="panel subcontract-detail" aria-label="Detalle del subcontrato">
      {error ? <p className="notice error panel-notice" role="alert">{error}</p> : <p className="empty-state" role="status">Cargando subcontrato…</p>}
    </section>;
  }
  const estimations = contract.estimations || [];
  const active = contract.state === 'activo';
  const drafts = estimations.some((item) => item.state === 'borrador');
  const state = SUBCONTRACT_STATE[contract.state];
  const cards: { label: string; value: string; foot: string; accent: string; testid: string }[] = [
    { label: 'Contratado', value: money(contract.contracted_amount), foot: `Garantía ${Number(contract.retention_percent)} %`, accent: '#17233c', testid: 'sc-contracted' },
    { label: 'Pagado (neto)', value: money(contract.paid_net), foot: 'Estimaciones pagadas', accent: '#1f8055', testid: 'sc-paid' },
    { label: 'Retenido', value: money(contract.retained), foot: 'Fondo de garantía acumulado', accent: '#b78027', testid: 'sc-retained' },
    { label: 'Por estimar', value: money(contract.remaining_to_estimate), foot: `Anticipo por amortizar ${money(contract.advance_pending_amortization)}`, accent: '#c66a3d', testid: 'sc-remaining' },
  ];

  return <section className="panel subcontract-detail" aria-labelledby="subcontract-detail-title">
    <div className="panel-header">
      <div>
        <span className="eyebrow">Subcontrato · {contract.category || 'MANO DE OBRA'}</span>
        <h2 id="subcontract-detail-title">{contract.folio} · {contract.supplier_name}</h2>
        <p>{contract.expense_item}{contract.expense_subitem ? ` › ${contract.expense_subitem}` : ''} · {contract.description}</p>
      </div>
      <div className="header-actions">
        <StatusPill tone={state.tone}>{state.label}</StatusPill>
        {canManage && active && onEdit && <button type="button" className="btn secondary" onClick={() => onEdit(contract)}>Editar</button>}
        <button type="button" className="btn secondary" onClick={onClose}>Cerrar</button>
      </div>
    </div>
    {message && <p className="notice success panel-notice" role="status">{message}</p>}
    {error && <p className="notice error panel-notice" role="alert">{error}</p>}
    <div className="metrics subcontract-metrics">
      {cards.map((card) => <article key={card.label} className="metric-card" style={{ '--accent': card.accent } as CSSProperties}>
        <span className="metric-label">{card.label}</span><strong className="metric-value" data-testid={card.testid}>{card.value}</strong><span className="metric-foot">{card.foot}</span>
      </article>)}
    </div>

    <div className="panel-header subheader">
      <div><h3>Historial de estimaciones</h3><p>{estimations.length} registrada{estimations.length === 1 ? '' : 's'} · una estimación pagada ya no se modifica</p></div>
      {canManage && active && !form && <button type="button" className="btn" onClick={() => { setMessage(''); setForm({}); }}><PlusIcon />Nueva estimación</button>}
    </div>
    {form && <div className="estimation-form-wrap"><EstimationForm key={form.estimation?.id || 'new'} contract={contract} estimations={estimations} initial={form.estimation}
      onCancel={() => setForm(null)}
      onSaved={(_saved, text) => { setForm(null); setMessage(text); void load(); onChanged(); }} /></div>}
    {estimations.length === 0
      ? <p className="empty-state">Aún no hay estimaciones. Registra un anticipo o el primer avance.</p>
      : <div className="expense-table-wrap"><table className="expense-table reconcile-table estimation-table" role="table">
        <caption className="sr-only">Historial de estimaciones de {contract.folio}</caption>
        <thead role="rowgroup"><tr role="row">{['Folio', 'Tipo', 'Bruto', '+ Aditivas', '− Deductivas', '− Amortización', '− Retención', 'Neto', 'Estado', 'Acciones'].map((label) => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody role="rowgroup">{estimations.map((item) => {
          const draft = item.state === 'borrador';
          const confirm = confirming?.id === item.id ? confirming.action : null;
          return <tr role="row" key={item.id}>
            <td role="cell" data-label="Folio"><strong>{item.folio}</strong><small>{item.estimated_on}</small></td>
            <td role="cell" data-label="Tipo">{KIND_LABEL[item.kind]}</td>
            <td role="cell" data-label="Bruto">{money(item.gross_amount)}</td>
            <td role="cell" data-label="+ Aditivas">{money(item.additions)}</td>
            <td role="cell" data-label="− Deductivas">{money(item.deductions)}</td>
            <td role="cell" data-label="− Amortización">{money(item.advance_amortization)}</td>
            <td role="cell" data-label="− Retención">{money(item.retention_amount)}</td>
            <td role="cell" data-label="Neto"><strong>{money(item.net_amount)}</strong>{item.adjustment_notes && <small>{item.adjustment_notes}</small>}</td>
            <td role="cell" data-label="Estado"><StatusPill tone={draft ? 'amber' : 'green'}>{draft ? 'Borrador' : 'Pagado'}</StatusPill>{!draft && <small>{[item.paid_by, formatDateTime(item.paid_at)].filter(Boolean).join(' · ')}</small>}{item.expense_folio && <small data-testid={`expense-link-${item.folio}`}>Gasto {item.expense_folio} (validado)</small>}</td>
            <td role="cell" data-label="Acciones">{confirm
              ? <div className="inline-confirm" role="group" aria-label={`Confirmar ${confirm === 'pay' ? 'pago' : 'eliminación'} de ${item.folio}`}>
                <span>{confirm === 'pay' ? `¿Pagar ${money(item.net_amount)}? Se registrará como gasto validado de hoy y no se puede revertir.` : `¿Eliminar el borrador ${item.folio}?`}</span>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => setConfirming(null)}>Cancelar</button>
                <button type="button" className={`btn${confirm === 'delete' ? ' danger' : ''}`} disabled={busy}
                  onClick={() => void (confirm === 'pay'
                    ? run(() => apiJson(`/subcontracts/${contract.id}/estimations/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ state: 'pagado' }) }), `Estimación ${item.folio} pagada; se registró el gasto validado.${item.kind === 'finiquito' ? ' El subcontrato quedó finiquitado.' : ''}`)
                    : run(() => apiFetch(`/subcontracts/${contract.id}/estimations/${item.id}`, { method: 'DELETE' }).then((response) => { if (!response.ok) throw new Error('No fue posible eliminar el borrador.'); }), `Borrador ${item.folio} eliminado.`))}>
                  {confirm === 'pay' ? 'Confirmar pago' : 'Eliminar'}</button>
              </div>
              : <div className="row-actions">
                {canManage && draft && active && <button type="button" className="text-action" disabled={busy} aria-label={`Pagar estimación ${item.folio}`} onClick={() => setConfirming({ id: item.id, action: 'pay' })}>Pagar/Aprobar</button>}
                {canManage && draft && active && <button type="button" className="text-action" disabled={busy} aria-label={`Corregir estimación ${item.folio}`} onClick={() => { setMessage(''); setForm({ estimation: item }); }}>Corregir</button>}
                {canManage && draft && <button type="button" className="text-action danger" disabled={busy} aria-label={`Eliminar estimación ${item.folio}`} onClick={() => setConfirming({ id: item.id, action: 'delete' })}>Eliminar</button>}
                <button type="button" className="text-action" aria-label={`Descargar recibo de ${item.folio}`} onClick={() => void receipt(item)}>Descargar recibo</button>
              </div>}</td>
          </tr>;
        })}</tbody>
      </table></div>}

    {canManage && active && <div className="subcontract-danger">{cancelling
      ? <div className="inline-confirm" role="group" aria-label="Confirmar cancelación del subcontrato">
        <span>{drafts ? 'Elimina o paga los borradores antes de cancelar.' : `¿Cancelar ${contract.folio}? Ya no admitirá estimaciones y sólo quedará comprometido lo pagado.`}</span>
        <button type="button" className="btn secondary" onClick={() => setCancelling(false)}>Volver</button>
        <button type="button" className="btn danger" disabled={busy || drafts} onClick={() => void run(() => apiJson(`/subcontracts/${contract.id}`, { method: 'PATCH', body: JSON.stringify({ state: 'cancelado' }) }), `Subcontrato ${contract.folio} cancelado.`)}>Cancelar subcontrato</button>
      </div>
      : <button type="button" className="text-action danger" onClick={() => setCancelling(true)}>Cancelar subcontrato…</button>}</div>}
  </section>;
}
