'use client';

import { useState } from 'react';
import { StatusPill } from '@/components/status-pill';
import type { components } from '@/lib/api.generated';
import { centsFromDecimal, displayCents } from '@/lib/money';
import { openSignedReceipt, receiptFileName } from '@/lib/receipts';

type IncomeResponse = components['schemas']['IncomeResponse'];
const KIND_LABEL: Record<string, string> = { pdf: 'PDF', xml: 'XML', imagen: 'Imagen' };

/** Read-only list of the work's incomes; receipts open or download via signed URLs. */
export function IncomeTable({ items }: { items: IncomeResponse[] }) {
  const [error, setError] = useState('');

  async function open(path: string, download: boolean) {
    setError('');
    try {
      await openSignedReceipt(path, download);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible abrir el comprobante.');
    }
  }

  return <>
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="expense-table-wrap"><table className="expense-table income-table" role="table">
      <caption className="sr-only">Ingresos de la obra</caption>
      <thead role="rowgroup"><tr role="row">{['Folio', 'Fecha', 'Concepto', 'Importe', 'Estado', 'Comprobantes'].map((label) => <th role="columnheader" scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody role="rowgroup">{items.map((income) => <tr role="row" key={income.id}>
        <td role="cell" data-label="Folio"><strong>{income.folio}</strong></td>
        <td role="cell" data-label="Fecha">{income.received_on}</td>
        <td role="cell" data-label="Concepto">{income.concept}</td>
        <td role="cell" data-label="Importe"><strong>{displayCents(centsFromDecimal(income.amount))}</strong></td>
        <td role="cell" data-label="Estado"><StatusPill tone={income.state === 'conciliado' ? 'green' : 'amber'}>{income.state === 'conciliado' ? 'Conciliado' : 'Pendiente'}</StatusPill></td>
        <td role="cell" data-label="Comprobantes">{(income.receipts || []).length === 0 ? <small>Sin comprobantes</small> : <ul className="income-receipts">{(income.receipts || []).map((receipt) => {
          const name = receiptFileName(receipt.path);
          return <li key={receipt.id}><span className="receipt-kind">{KIND_LABEL[receipt.kind] || receipt.kind}</span><span className="income-receipt-name">{name}</span>
            <button type="button" className="text-action" aria-label={`Ver ${name} del ingreso ${income.folio}`} onClick={() => void open(receipt.path, false)}>Ver</button>
            <button type="button" className="text-action" aria-label={`Descargar ${name} del ingreso ${income.folio}`} onClick={() => void open(receipt.path, true)}>Descargar</button></li>;
        })}</ul>}</td>
      </tr>)}</tbody>
    </table>{items.length === 0 && <p className="empty-state">Aún no hay ingresos registrados en esta obra.</p>}</div>
  </>;
}
