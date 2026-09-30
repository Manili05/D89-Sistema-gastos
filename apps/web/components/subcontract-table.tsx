'use client';

import { PlusIcon, ReceiptIcon } from '@/components/icons';
import { StatusPill } from '@/components/status-pill';
import type { Subcontract } from '@/lib/estimation';
import { centsFromDecimal, displayCents } from '@/lib/money';

export const SUBCONTRACT_STATE: Record<Subcontract['state'], { label: string; tone: 'green' | 'navy' | 'red' }> = {
  activo: { label: 'Activo', tone: 'navy' },
  finiquitado: { label: 'Finiquitado', tone: 'green' },
  cancelado: { label: 'Cancelado', tone: 'red' },
};

/** Work's piecework contracts; "Ver" opens the detail, "Editar" only for active ones (admin). */
export function SubcontractTable({ items, onView, onEdit, onCreate }: {
  items: Subcontract[];
  onView: (item: Subcontract) => void;
  onEdit?: (item: Subcontract) => void;
  onCreate?: () => void;
}) {
  if (items.length === 0) {
    return <div className="income-empty">
      <span className="income-empty-icon" aria-hidden="true"><ReceiptIcon size={26} /></span>
      <h3>Aún no hay subcontratos en esta obra</h3>
      <p>Registra los destajos de mano de obra con su importe contratado y fondo de garantía; después captura sus anticipos, avances y finiquito.</p>
      {onCreate && <button type="button" className="btn" onClick={onCreate}><PlusIcon />Registrar el primer subcontrato</button>}
    </div>;
  }
  return <div className="expense-table-wrap income-table-wrap"><table className="expense-table income-table subcontract-table" role="table">
    <caption className="sr-only">Subcontratos de la obra</caption>
    <thead role="rowgroup"><tr role="row">{['Folio', 'Proveedor', 'Partida / subpartida', 'Importe contratado', 'Pagado', 'Estado', 'Acciones'].map((label) => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody role="rowgroup">{items.map((item) => {
      const state = SUBCONTRACT_STATE[item.state];
      return <tr role="row" key={item.id}>
        <td role="cell" data-label="Folio"><strong>{item.folio}</strong></td>
        <td role="cell" data-label="Proveedor">{item.supplier_name || '—'}<small>{item.description}</small></td>
        <td role="cell" data-label="Partida / subpartida">{item.expense_item || 'Sin partida'}{item.expense_subitem ? ` › ${item.expense_subitem}` : ''}<small>{item.category || ''}</small></td>
        <td role="cell" data-label="Importe contratado"><strong>{displayCents(centsFromDecimal(item.contracted_amount))}</strong><small>Garantía {Number(item.retention_percent)} %</small></td>
        <td role="cell" data-label="Pagado">{displayCents(centsFromDecimal(item.paid_net))}</td>
        <td role="cell" data-label="Estado"><StatusPill tone={state.tone}>{state.label}</StatusPill></td>
        <td role="cell" data-label="Acciones"><div className="row-actions">
          <button type="button" className="text-action" aria-label={`Ver subcontrato ${item.folio}`} onClick={() => onView(item)}>Ver</button>
          {onEdit && item.state === 'activo' && <button type="button" className="text-action" aria-label={`Editar subcontrato ${item.folio}`} onClick={() => onEdit(item)}>Editar</button>}
        </div></td>
      </tr>;
    })}</tbody>
  </table></div>;
}
