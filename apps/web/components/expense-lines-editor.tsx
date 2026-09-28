'use client';

import { type Totals, type LineDraft, displayCents, newLine } from '@/lib/money';

/**
 * Header-detail concepts with live totals. Prices include IVA (the business rule);
 * the "IVA" checkbox marks taxable lines, exempt lines add no IVA. All math comes
 * from lib/money.ts, which mirrors the backend exactly.
 */
/** Only flag a line once the user entered a price or discount (a fresh row is not an error). */
function touched(line: LineDraft): boolean {
  return line.unitPrice.trim() !== '' || line.discount.trim() !== '';
}

export function ExpenseLinesEditor({ lines, totals, explicitIvaLabel, disabled, onChange }: {
  lines: LineDraft[];
  totals: Totals;
  /** Set when the IVA comes from a document (CFDI/saved expense) instead of the 16 % rule. */
  explicitIvaLabel?: string | null;
  disabled?: boolean;
  onChange: (lines: LineDraft[]) => void;
}) {
  function update(key: string, patch: Partial<LineDraft>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  }

  return <fieldset className="expense-lines" aria-label="Conceptos del gasto" disabled={disabled}>
    <legend>Conceptos <span className="field-hint">Precios con IVA incluido</span></legend>
    <div className="expense-lines-table">
      {/* Visual headers only: every input carries its own accessible label. */}
      <div className="expense-line head" aria-hidden="true">
        <span>Cantidad</span><span>Unidad</span><span>Descripción</span><span>P. unitario</span>
        <span>Descuento</span><span>IVA</span><span>Importe</span><span />
      </div>
      {lines.map((line, index) => {
        const position = index + 1;
        const cents = totals.lineCents[index];
        const invalid = cents === null && touched(line);
        return <div className={`expense-line${invalid ? ' invalid' : ''}`} key={line.key}>
          <input aria-label={`Cantidad concepto ${position}`} inputMode="decimal" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} required />
          <input aria-label={`Unidad concepto ${position}`} value={line.unit} maxLength={40} onChange={(event) => update(line.key, { unit: event.target.value })} required />
          <input aria-label={`Descripción concepto ${position}`} value={line.description} maxLength={500} onChange={(event) => update(line.key, { description: event.target.value })} required />
          <input aria-label={`Precio unitario concepto ${position}`} inputMode="decimal" placeholder="0.00" value={line.unitPrice} onChange={(event) => update(line.key, { unitPrice: event.target.value })} required />
          <input aria-label={`Descuento concepto ${position}`} inputMode="decimal" placeholder="0.00" value={line.discount} onChange={(event) => update(line.key, { discount: event.target.value })} />
          <label className="line-taxable"><input type="checkbox" aria-label={`IVA concepto ${position}`} checked={line.taxable} onChange={(event) => update(line.key, { taxable: event.target.checked })} /><span aria-hidden="true">16 %</span></label>
          {/* Plain text, not <output>: an implicit live region per line would announce every keystroke. */}
          <span className="line-amount" data-testid={`line-amount-${position}`}><span className="sr-only">Importe concepto {position}: </span>{displayCents(cents ?? null)}</span>
          <button type="button" className="text-action danger" aria-label={`Quitar concepto ${position}`} disabled={lines.length === 1} onClick={() => onChange(lines.filter((item) => item.key !== line.key))}>✕</button>
        </div>;
      })}
    </div>
    {lines.some((line, index) => totals.lineCents[index] === null && touched(line)) && <p className="field-error" role="alert">Revisa cantidad, precio y descuento: usa números con hasta 4 decimales y un descuento que no supere cantidad × precio.</p>}
    <div className="expense-lines-footer">
      <button type="button" className="btn secondary" onClick={() => onChange([...lines, newLine()])}>+ Agregar concepto</button>
      <dl className="expense-totals" aria-live="polite">
        <div><dt>Subtotal</dt><dd data-testid="expense-subtotal">{displayCents(totals.subtotalCents)}</dd></div>
        <div><dt>IVA{explicitIvaLabel ? ` (${explicitIvaLabel})` : ''}</dt><dd data-testid="expense-iva">{displayCents(totals.ivaCents)}</dd></div>
        <div className="grand"><dt>Total</dt><dd data-testid="expense-total">{displayCents(totals.totalCents)}</dd></div>
      </dl>
    </div>
  </fieldset>;
}
