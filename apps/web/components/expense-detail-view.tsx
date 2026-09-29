'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StatusPill } from '@/components/status-pill';
import type { components } from '@/lib/api.generated';
import { apiJson, getSupabaseBrowserClient } from '@/lib/auth';
import { displayCents, toUnits, trimDecimal } from '@/lib/money';

type ExpenseDetail = components['schemas']['ExpenseResponse'];
type Receipt = ExpenseDetail['receipts'][number];

const unitPrice = new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 4,
});
const dateTime = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Mexico_City' });
const KIND_LABEL: Record<string, string> = { pdf: 'PDF', xml: 'XML', imagen: 'Imagen' };

function money(value: string | number | null | undefined): string {
  return displayCents(value === null || value === undefined ? null : toUnits(trimDecimal(value), 2n));
}

function stateTone(state: string): 'green' | 'amber' | 'red' | 'navy' {
  if (state === 'validado') return 'green';
  if (state === 'rechazado') return 'red';
  return 'amber';
}

function fileName(path: string): string {
  // Stored as {obra}/{gasto}/{timestamp}-{id}-{name}: show the original name.
  return path.split('/').pop()!.replace(/^\d+-(receipt-\d+-)?/, '');
}

/**
 * Read-only expense detail (header, concepts, totals, receipts). It has no form
 * fields and performs no mutations: only a GET of the expense and short-lived
 * signed Storage URLs to view or download its receipts.
 */
export function ExpenseDetailView({ expenseId, onClose }: { expenseId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<ExpenseDetail | null>(null);
  const [error, setError] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  // Parents usually pass an inline callback; a ref keeps the modal effect mount-only.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    apiJson<ExpenseDetail>(`/expenses/${expenseId}`)
      .then((value) => { if (!cancelled) setDetail(value); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [expenseId]);

  // Modal behaviour: focus the close button, close on Escape, restore focus on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') onCloseRef.current(); }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);

  async function openReceipt(receipt: Receipt, download: boolean) {
    setReceiptError('');
    const { data, error: storageError } = await getSupabaseBrowserClient().storage.from('comprobantes')
      .createSignedUrl(receipt.path, 300, download ? { download: fileName(receipt.path) } : undefined);
    if (storageError || !data) {
      setReceiptError(storageError?.message || 'No fue posible abrir el comprobante.');
      return;
    }
    if (download) {
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.rel = 'noopener';
      link.click();
    } else {
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    }
  }

  const hasDiscount = Boolean(detail?.lines.some((line) => Number(line.discount) > 0));
  const classification = detail ? [detail.expense_item, detail.expense_subitem, detail.expense_category].filter(Boolean).join(' › ') : '';

  if (typeof document === 'undefined') return null;
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="confirm-dialog detail-dialog" role="dialog" aria-modal="true" aria-labelledby="expense-detail-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="detail-dialog-header">
        <div><span className="eyebrow">Consulta de gasto · sólo lectura</span><h2 id="expense-detail-title">{detail ? `Gasto ${detail.folio}` : 'Gasto'}</h2></div>
        <button ref={closeButton} type="button" className="btn secondary" onClick={onClose}>Cerrar</button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {!detail && !error && <p role="status">Cargando gasto…</p>}
      {detail && <>
        <dl className="detail-header">
          <div><dt>Folio</dt><dd>{detail.folio}</dd></div>
          <div><dt>Folio del proveedor</dt><dd>{detail.supplier_folio || '—'}</dd></div>
          <div><dt>Proveedor</dt><dd>{detail.supplier_name || '—'}</dd></div>
          <div><dt>Fecha</dt><dd>{detail.spent_on}</dd></div>
          <div className="wide"><dt>Área</dt><dd>{detail.area_path?.join(' › ') || '—'}</dd></div>
          <div className="wide"><dt>Clasificación</dt><dd>{classification || '—'}</dd></div>
          {detail.budget_item && <div className="wide"><dt>Partida NEODATA</dt><dd>{detail.budget_item}</dd></div>}
          <div><dt>Estado</dt><dd><StatusPill tone={stateTone(detail.state)}>{detail.state}</StatusPill></dd></div>
          <div><dt>Capturó</dt><dd>{detail.author || '—'}{detail.created_at ? ` · ${dateTime.format(new Date(detail.created_at))}` : ''}</dd></div>
          {detail.review_reason && <div className="wide"><dt>Motivo de revisión</dt><dd>{detail.review_reason}</dd></div>}
          <div className="wide"><dt>Concepto general</dt><dd>{detail.concept}</dd></div>
        </dl>

        <h3 className="detail-section-title">Conceptos</h3>
        <div className="expense-table-wrap"><table className="expense-table detail-lines" role="table">
          <caption className="sr-only">Conceptos del gasto {detail.folio}</caption>
          <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Cantidad</th><th role="columnheader" scope="col">Unidad</th><th role="columnheader" scope="col">Descripción</th><th role="columnheader" scope="col">P. unitario</th>{hasDiscount && <th role="columnheader" scope="col">Descuento</th>}<th role="columnheader" scope="col">Importe</th></tr></thead>
          <tbody role="rowgroup">{detail.lines.map((line) => <tr role="row" key={line.position}>
            <td role="cell" data-label="Cantidad">{trimDecimal(line.quantity)}</td><td role="cell" data-label="Unidad">{line.unit}</td><td role="cell" data-label="Descripción">{line.description}</td>
            <td role="cell" data-label="P. unitario">{unitPrice.format(Number(line.unit_price))}</td>{hasDiscount && <td role="cell" data-label="Descuento">{Number(line.discount) ? money(line.discount) : '—'}</td>}
            <td role="cell" data-label="Importe"><strong>{money(line.amount)}</strong></td>
          </tr>)}</tbody>
        </table></div>

        <dl className="expense-totals detail-totals">
          <div><dt>Subtotal</dt><dd data-testid="detail-subtotal">{money(detail.subtotal)}</dd></div>
          <div><dt>IVA{detail.iva_breakdown ? '' : ' (no desglosado)'}</dt><dd data-testid="detail-iva">{money(detail.iva)}</dd></div>
          <div className="grand"><dt>Total</dt><dd data-testid="detail-total">{money(detail.amount)}</dd></div>
        </dl>
        <p className="field-hint">Precios con IVA incluido.{detail.iva_breakdown ? '' : ' Este gasto se registró sin desglose de IVA.'}</p>

        <h3 className="detail-section-title">Comprobantes</h3>
        {receiptError && <p className="notice error" role="alert">{receiptError}</p>}
        {detail.receipts.length === 0
          ? <p className="empty-state">Sin comprobantes adjuntos.</p>
          : <ul className="receipt-list">{detail.receipts.map((receipt) => <li key={receipt.id}>
              <span className="receipt-kind">{KIND_LABEL[receipt.kind] || receipt.kind}</span>
              <span>{fileName(receipt.path)}</span>
              <button type="button" className="text-action" onClick={() => void openReceipt(receipt, false)} aria-label={`Ver ${fileName(receipt.path)}`}>Ver</button>
              <button type="button" className="text-action" onClick={() => void openReceipt(receipt, true)} aria-label={`Descargar ${fileName(receipt.path)}`}>Descargar</button>
            </li>)}</ul>}
      </>}
    </section>
  </div>, document.body);
}
