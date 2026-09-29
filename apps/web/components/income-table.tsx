'use client';

import { useState } from 'react';
import { PlusIcon, ReceiptIcon } from '@/components/icons';
import { StatusPill } from '@/components/status-pill';
import { type IncomeResponse, RECEIPT_KIND_LABEL as KIND_LABEL, reconciledBy } from '@/lib/incomes';
import { centsFromDecimal, displayCents } from '@/lib/money';
import { openSignedReceipt, receiptFileName } from '@/lib/receipts';

/**
 * List of the work's incomes; receipts open or download via signed URLs. "Ver" opens
 * the read-only detail; `onEdit` and `onCreate` are only passed for administration.
 */
export function IncomeTable({ items, onView, onEdit, onCreate }: {
  items: IncomeResponse[];
  onView: (income: IncomeResponse) => void;
  onEdit?: (income: IncomeResponse) => void;
  onCreate?: () => void;
}) {
  const [error, setError] = useState('');

  async function open(path: string, download: boolean) {
    setError('');
    try {
      await openSignedReceipt(path, download);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible abrir el comprobante.');
    }
  }

  if (items.length === 0) {
    return <div className="income-empty">
      <span className="income-empty-icon" aria-hidden="true"><ReceiptIcon size={26} /></span>
      <h3>Aún no hay ingresos registrados en esta obra</h3>
      <p>Registra anticipos, estimaciones y demás cobros con su comprobante; después se concilian en Validación.</p>
      {onCreate && <button type="button" className="btn" onClick={onCreate}><PlusIcon />Registrar el primer ingreso</button>}
    </div>;
  }

  return <>
    {error && <p className="notice error panel-notice" role="alert">{error}</p>}
    <div className="expense-table-wrap income-table-wrap"><table className="expense-table income-table" role="table">
      <caption className="sr-only">Ingresos de la obra</caption>
      <thead role="rowgroup"><tr role="row">{['Folio', 'Fecha', 'Concepto', 'Importe', 'Estado', 'Comprobantes', 'Acciones'].map((label) => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody role="rowgroup">{items.map((income) => <tr role="row" key={income.id}>
        <td role="cell" data-label="Folio"><strong>{income.folio}</strong></td>
        <td role="cell" data-label="Fecha">{income.received_on}</td>
        <td role="cell" data-label="Concepto">{income.concept}</td>
        <td role="cell" data-label="Importe"><strong>{displayCents(centsFromDecimal(income.amount))}</strong></td>
        <td role="cell" data-label="Estado" className="income-state-cell"><div><StatusPill tone={income.state === 'conciliado' ? 'green' : 'amber'}>{income.state === 'conciliado' ? 'Conciliado' : 'Pendiente'}</StatusPill>
          {reconciledBy(income) && <small>{reconciledBy(income)}</small>}
          {income.state === 'pendiente' && income.reversal_reason && <small className="reversal-note">Revertido: {income.reversal_reason}</small>}</div></td>
        <td role="cell" data-label="Comprobantes">{(income.receipts || []).length === 0 ? <small>Sin comprobantes</small> : <ul className="income-receipts">{(income.receipts || []).map((receipt) => {
          const name = receiptFileName(receipt.path);
          return <li key={receipt.id}><span className="receipt-kind">{KIND_LABEL[receipt.kind] || receipt.kind}</span><span className="income-receipt-name">{name}</span>
            <button type="button" className="text-action" aria-label={`Ver ${name} del ingreso ${income.folio}`} onClick={() => void open(receipt.path, false)}>Ver</button>
            <button type="button" className="text-action" aria-label={`Descargar ${name} del ingreso ${income.folio}`} onClick={() => void open(receipt.path, true)}>Descargar</button></li>;
        })}</ul>}</td>
        <td role="cell" data-label="Acciones"><div className="row-actions">
          <button type="button" className="text-action" aria-label={`Ver ingreso ${income.folio}`} onClick={() => onView(income)}>Ver</button>
          {onEdit && <button type="button" className="text-action" aria-label={`Editar ingreso ${income.folio}`} onClick={() => onEdit(income)}>Editar</button>}
        </div></td>
      </tr>)}</tbody>
    </table></div>
  </>;
}
