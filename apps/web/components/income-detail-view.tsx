'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { StatusPill } from '@/components/status-pill';
import { apiJson } from '@/lib/auth';
import { formatDateTime, type IncomeResponse, RECEIPT_KIND_LABEL, reconciledBy } from '@/lib/incomes';
import { centsFromDecimal, displayCents } from '@/lib/money';
import { openSignedReceipt, receiptFileName } from '@/lib/receipts';

type Receipt = NonNullable<IncomeResponse['receipts']>[number];

/**
 * Read-only income detail. It performs no mutations: a GET of the income and
 * short-lived signed Storage URLs to view or download its receipts. `onEdit`
 * (administration only) hands over to the edit form.
 */
export function IncomeDetailView({ incomeId, onClose, onEdit }: {
  incomeId: string;
  onClose: () => void;
  onEdit?: (income: IncomeResponse) => void;
}) {
  const [detail, setDetail] = useState<IncomeResponse | null>(null);
  const [error, setError] = useState('');
  const [receiptError, setReceiptError] = useState('');
  const closeButton = useRef<HTMLButtonElement>(null);
  // Parents usually pass an inline callback; a ref keeps the modal effect mount-only.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    apiJson<IncomeResponse>(`/incomes/${incomeId}`)
      .then((value) => { if (!cancelled) setDetail(value); })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [incomeId]);

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
    try {
      await openSignedReceipt(receipt.path, download);
    } catch (reason) {
      setReceiptError(reason instanceof Error ? reason.message : 'No fue posible abrir el comprobante.');
    }
  }

  if (typeof document === 'undefined') return null;
  const receipts = detail?.receipts || [];
  return createPortal(<div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="confirm-dialog detail-dialog income-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="income-detail-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="detail-dialog-header">
        <div><span className="eyebrow">Consulta de ingreso · sólo lectura</span><h2 id="income-detail-title">{detail ? `Ingreso ${detail.folio}` : 'Ingreso'}</h2></div>
        <div className="header-actions">
          {detail && onEdit && <button type="button" className="btn secondary" onClick={() => onEdit(detail)}>Editar</button>}
          <button ref={closeButton} type="button" className="btn secondary" onClick={onClose}>Cerrar</button>
        </div>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {!detail && !error && <p role="status">Cargando ingreso…</p>}
      {detail && <>
        <dl className="detail-header">
          <div><dt>Folio</dt><dd>{detail.folio}</dd></div>
          <div><dt>Fecha</dt><dd>{detail.received_on}</dd></div>
          <div><dt>Importe</dt><dd data-testid="income-detail-amount"><strong>{displayCents(centsFromDecimal(detail.amount))}</strong></dd></div>
          <div><dt>Estado</dt><dd><StatusPill tone={detail.state === 'conciliado' ? 'green' : 'amber'}>{detail.state === 'conciliado' ? 'Conciliado' : 'Pendiente'}</StatusPill></dd></div>
          <div className="wide"><dt>Concepto</dt><dd>{detail.concept}</dd></div>
          <div className="wide"><dt>Registrado</dt><dd>{formatDateTime(detail.created_at) || '—'}</dd></div>
          {detail.state === 'conciliado' && <div className="wide"><dt>Conciliado por</dt><dd>{reconciledBy(detail) || '—'}</dd></div>}
          {detail.state === 'pendiente' && detail.reversal_reason && <div className="wide"><dt>Motivo de la última reversión</dt><dd>{detail.reversal_reason}</dd></div>}
        </dl>

        <h3 className="detail-section-title">Comprobantes</h3>
        {receiptError && <p className="notice error" role="alert">{receiptError}</p>}
        {receipts.length === 0
          ? <p className="empty-state">Sin comprobantes adjuntos.</p>
          : <ul className="receipt-list">{receipts.map((receipt) => {
            const name = receiptFileName(receipt.path);
            return <li key={receipt.id}>
              <span className="receipt-kind">{RECEIPT_KIND_LABEL[receipt.kind] || receipt.kind}</span>
              <span>{name}</span>
              <button type="button" className="text-action" onClick={() => void openReceipt(receipt, false)} aria-label={`Ver ${name}`}>Ver</button>
              <button type="button" className="text-action" onClick={() => void openReceipt(receipt, true)} aria-label={`Descargar ${name}`}>Descargar</button>
            </li>;
          })}</ul>}
      </>}
    </section>
  </div>, document.body);
}
