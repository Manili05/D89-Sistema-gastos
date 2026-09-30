'use client';

import { useEffect, useRef, useState } from 'react';
import { UploadIcon } from '@/components/icons';
import { AI_MANUAL_FALLBACK, aiErrorMessage, aiRequest, isAbort } from '@/lib/ai';
import type { components } from '@/lib/api.generated';
import { type LineDraft, formatCents, lineAmountCents, newLine, toUnits, trimDecimal } from '@/lib/money';

type Extraction = components['schemas']['ReceiptExtraction-Output'];
type ReceiptResponse = components['schemas']['ReceiptExtractionResponse'];
type JevResponse = components['schemas']['JevChatResponse'];
type ChatMessage = { from: 'usuario' | 'jev'; text: string };

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_ERRORS: Record<number, string> = {
  413: 'La imagen supera el límite de 10 MB.',
  415: 'El archivo no es una imagen JPEG, PNG o WebP válida.',
  502: 'La IA no pudo leer el ticket con certeza.',
};
const JEV_ERRORS: Record<number, string> = {
  422: 'Jev no pudo procesar esa corrección. Escríbela de forma más breve (máx. 1000 caracteres).',
  502: 'Jev no entendió la corrección. Intenta redactarla de otra forma.',
};
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

function amount(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : money.format(Number(value));
}

/**
 * Ticket lines → expense lines (ticket prices include IVA, so every line is taxable).
 * When the printed line amount is lower than quantity × price (an unlabeled discount),
 * the exact difference becomes the line discount so the line matches the ticket.
 */
export function receiptToLines(extraction: Extraction): LineDraft[] {
  return extraction.conceptos.filter((item) => item.descripcion).map((item) => {
    const quantity = trimDecimal(item.cantidad) || '1';
    const unitPrice = trimDecimal(item.precio_unitario ?? item.importe) || '';
    let discount = '';
    const gross = lineAmountCents({ quantity, unitPrice, discount: '' });
    const printed = item.importe === null || item.importe === undefined ? null : toUnits(trimDecimal(item.importe), 2n);
    if (gross !== null && printed !== null && printed < gross) discount = formatCents(gross - printed);
    return newLine({
      quantity, unit: item.unidad || 'pieza', description: (item.descripcion || '').slice(0, 500),
      unitPrice, discount, taxable: true,
    });
  });
}

/** General concept text for the expense header, from the ticket lines. */
export function receiptConcept(extraction: Extraction): string {
  return extraction.conceptos
    .filter((item) => item.descripcion)
    .map((item) => (item.cantidad ? `${Number(item.cantidad)} × ${item.descripcion}` : item.descripcion))
    .join('; ')
    .slice(0, 500);
}

/**
 * Optional ticket photo -> AI extraction -> Jev corrections. It never writes the
 * expense: the user applies the values to the regular form (or ignores them) and
 * the photo is handed to the form so it is linked as the expense's receipt.
 */
export function ReceiptAssistant({ disabled, onBusyChange, onFile, onApply }: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onFile: (file: File | null) => void;
  onApply: (values: { lines: LineDraft[]; concept: string }) => void;
}) {
  const [fileName, setFileName] = useState('');
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [phase, setPhase] = useState<'idle' | 'extracting' | 'chatting'>('idle');
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [applied, setApplied] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const busy = phase !== 'idle';

  useEffect(() => () => controller.current?.abort(), []);

  function setBusy(next: typeof phase) {
    setPhase(next);
    onBusyChange(next !== 'idle');
  }

  async function analyze(file: File) {
    if (busy) return;
    setError('');
    if (!IMAGE_TYPES.includes(file.type)) {
      setError(`${aiErrorMessage(415, RECEIPT_ERRORS)} ${AI_MANUAL_FALLBACK}`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`${aiErrorMessage(413, RECEIPT_ERRORS)} ${AI_MANUAL_FALLBACK}`);
      return;
    }
    // The photo is the physical receipt: it is attached on save even if the AI fails.
    setFileName(file.name);
    onFile(file);
    setExtraction(null);
    setMessages([]);
    setApplied(false);
    controller.current = new AbortController();
    setBusy('extracting');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const result = await aiRequest<ReceiptResponse>(
        '/expenses/extract-receipt', { method: 'POST', body, signal: controller.current.signal }, RECEIPT_ERRORS,
      );
      setExtraction(result.extraction);
    } catch (reason) {
      if (isAbort(reason)) return;
      const detail = reason instanceof Error ? reason.message : aiErrorMessage(503);
      setError(`${detail} La foto se adjuntará como comprobante. ${AI_MANUAL_FALLBACK}`);
    } finally {
      controller.current = null;
      setBusy('idle');
    }
  }

  // Rendered inside the expense <form>: no nested form, and Enter must not submit the expense.
  async function sendCorrection() {
    const text = instruction.trim();
    if (!extraction || busy || text.length < 2) return;
    setError('');
    setMessages((current) => [...current, { from: 'usuario', text }]);
    setInstruction('');
    controller.current = new AbortController();
    setBusy('chatting');
    try {
      const result = await aiRequest<JevResponse>('/expenses/jev-chat', {
        method: 'POST',
        body: JSON.stringify({ extraction, instruction: text }),
        signal: controller.current.signal,
      }, JEV_ERRORS);
      setExtraction(result.extraction);
      setApplied(false);
      setMessages((current) => [...current, { from: 'jev', text: result.respuesta }]);
    } catch (reason) {
      if (isAbort(reason)) return;
      setInstruction(text);
      setError(reason instanceof Error ? reason.message : aiErrorMessage(503));
    } finally {
      controller.current = null;
      setBusy('idle');
    }
  }

  function clear() {
    setFileName('');
    setExtraction(null);
    setMessages([]);
    setError('');
    setApplied(false);
    onFile(null);
  }

  function apply() {
    if (!extraction) return;
    onApply({ lines: receiptToLines(extraction), concept: receiptConcept(extraction) });
    setApplied(true);
  }

  return <section className="receipt-assistant" aria-label="Captura inteligente del ticket" aria-busy={busy}>
    <label className={`dropzone compact${phase === 'extracting' ? ' busy' : ''}`}><span><span className="dropzone-icon"><UploadIcon size={22} /></span><strong>{phase === 'extracting' ? 'Leyendo ticket con IA…' : fileName || 'Capturar desde foto del ticket (opcional)'}</strong><p>{phase === 'extracting' ? 'Esto puede tardar unos segundos.' : fileName ? 'Se adjuntará como comprobante del gasto. Selecciona otra foto para reemplazarla.' : 'JPEG, PNG o WebP · máximo 10 MB. También puedes capturar todo a mano.'}</p><input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Foto del ticket o nota de remisión" disabled={disabled || busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void analyze(file); }} /></span></label>
    {phase === 'extracting' && <p className="sr-only" role="status">Leyendo ticket con IA…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {extraction && <div className="receipt-summary">
      <div className="receipt-summary-header"><h3>Lectura del ticket</h3>{fileName && <button type="button" className="text-action" disabled={busy} onClick={clear}>Quitar ticket</button>}</div>
      <div className="expense-table-wrap"><table className="expense-table receipt-lines"><thead><tr><th>Concepto</th><th>Cant.</th><th>P. unitario</th><th>Importe</th></tr></thead><tbody>{extraction.conceptos.map((item, index) => <tr key={index}><td>{item.descripcion || <span className="missing-receipt">Ilegible</span>}</td><td>{item.cantidad ?? '—'}</td><td>{amount(item.precio_unitario)}</td><td>{item.cantidad && item.precio_unitario ? amount(String(Number(item.cantidad) * Number(item.precio_unitario))) : '—'}</td></tr>)}</tbody></table>{extraction.conceptos.length === 0 && <p className="empty-state">No se detectaron conceptos.</p>}</div>
      <dl className="receipt-totals"><div><dt>Total en el ticket</dt><dd>{amount(extraction.total_detectado)}</dd></div><div><dt>Suma de conceptos</dt><dd>{amount(extraction.suma_conceptos)}</dd></div></dl>
      {extraction.requiere_validacion_humana
        ? <div className="notice" role="status"><strong>Revisa antes de guardar.</strong>{extraction.motivos_revision.length > 0 && <ul>{extraction.motivos_revision.map((reason) => <li key={reason}>{reason}</li>)}</ul>}</div>
        : <p className="notice success" role="status">La suma de conceptos coincide con el total.</p>}
      <div className="header-actions"><button type="button" className="btn secondary" disabled={busy || disabled} onClick={apply}>Usar en el formulario</button>{applied && <span className="field-hint" role="status">Conceptos copiados al formulario. Puedes editarlos abajo.</span>}</div>
      <div className="jev-chat">
        <h3>Corregir con Jev</h3>
        {messages.length > 0 && <ol className="jev-messages" aria-live="polite">{messages.map((message, index) => <li key={index} className={message.from}><span>{message.from === 'jev' ? 'Jev' : 'Tú'}</span>{message.text}</li>)}</ol>}
        <div className="jev-input">
          <input aria-label="Corrección para Jev" placeholder="Ej. El segundo concepto es pintura, no cemento" value={instruction} maxLength={1000} disabled={busy || disabled} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void sendCorrection(); } }} />
          <button type="button" className="btn" disabled={busy || disabled || instruction.trim().length < 2} onClick={() => void sendCorrection()}>{phase === 'chatting' ? 'Jev está revisando…' : 'Enviar a Jev'}</button>
        </div>
      </div>
    </div>}
  </section>;
}
