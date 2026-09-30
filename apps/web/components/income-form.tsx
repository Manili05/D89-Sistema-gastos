'use client';

import { type DragEvent, type FormEvent, useRef, useState } from 'react';
import { PlusIcon, UploadIcon } from '@/components/icons';
import type { components } from '@/lib/api.generated';
import { apiJson } from '@/lib/auth';
import { centsFromDecimal, displayCents, toUnits, trimDecimal } from '@/lib/money';
import { MAX_RECEIPT_BYTES, receiptExtension, receiptFileName, receiptPath, uploadReceipt } from '@/lib/receipts';

type IncomeCreate = components['schemas']['IncomeCreate'];
type IncomeUpdate = components['schemas']['IncomeUpdate'];
type IncomeResponse = components['schemas']['IncomeResponse'];
type ReceiptItem = {
  id: string; file: File;
  /** Storage path once uploaded; a retry then only re-links, never re-uploads. */
  path?: string; linked: boolean; error?: string;
};

// Transfer vouchers and invoices: PDF or images (per the income module scope).
const INCOME_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png', 'webp']);
const CONCEPT_SUGGESTIONS = ['Anticipo', 'Estimación', 'Pago de estimación', 'Finiquito', 'Aportación del cliente'];
let receiptSequence = 0;

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Register one income (admin only in the API) and attach any number of transfer
 * vouchers or invoices. Mirrors the expense form's retry model: the income is created
 * once; a failed file is retried alone without creating another income.
 *
 * With `initialData` it edits that income instead: fields are prefilled, only the
 * changed ones go in `PATCH /incomes/{id}`, existing receipts are kept and new ones
 * are appended. A retry after a failed upload does not repeat an applied edit.
 */
export function IncomeForm({ workId, initialData, onSaved, onCancel }: {
  workId: string;
  initialData?: IncomeResponse;
  onSaved: (income: IncomeResponse, message: string) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initialData);
  const [receivedOn, setReceivedOn] = useState(() => initialData?.received_on ?? localDate());
  const [concept, setConcept] = useState(initialData?.concept ?? '');
  const [amount, setAmount] = useState(() => (initialData ? trimDecimal(initialData.amount) : ''));
  /** Server state the edit is compared against; refreshed after each applied PATCH. */
  const [baseline, setBaseline] = useState<IncomeResponse | undefined>(initialData);
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [created, setCreated] = useState<IncomeResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const amountUnits = toUnits(amount.replace(/,/g, ''), 4n);
  const amountValid = amountUnits !== null && amountUnits > 0n;
  const pending = receipts.filter((item) => !item.linked);
  const fieldsValid = amountValid && concept.trim().length >= 3 && Boolean(receivedOn);

  function changes(): IncomeUpdate {
    if (!baseline) return {};
    const update: IncomeUpdate = {};
    if (receivedOn !== baseline.received_on) update.received_on = receivedOn;
    if (concept.trim() !== baseline.concept) update.concept = concept.trim();
    if (amountUnits !== toUnits(trimDecimal(baseline.amount), 4n)) update.amount = amount.trim().replace(/,/g, '');
    return update;
  }
  const changed = Object.keys(changes()).length > 0;

  function addFiles(files: File[]) {
    const accepted: ReceiptItem[] = [];
    const refused: string[] = [];
    for (const file of files) {
      if (!INCOME_EXTENSIONS.has(receiptExtension(file.name))) refused.push(`${file.name}: sólo PDF o imagen`);
      else if (file.size > MAX_RECEIPT_BYTES) refused.push(`${file.name}: supera 10 MB`);
      else {
        receiptSequence += 1;
        accepted.push({ id: `income-receipt-${receiptSequence}`, file, linked: false });
      }
    }
    setRejected(refused);
    setReceipts((current) => [...current, ...accepted]);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    addFiles(Array.from(event.dataTransfer.files));
  }

  async function uploadAndLink(incomeId: string): Promise<{ failures: string[]; latest?: IncomeResponse }> {
    const failures: string[] = [];
    let latest: IncomeResponse | undefined;
    for (const item of receipts) {
      if (item.linked) continue;
      let path = item.path;
      try {
        if (!path) {
          const candidate = receiptPath(workId, incomeId, item.id, item.file);
          await uploadReceipt(candidate, item.file);
          path = candidate;
          setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path } : entry)));
        }
        latest = await apiJson<IncomeResponse>(`/incomes/${incomeId}/receipts`, {
          method: 'POST', body: JSON.stringify({ path }),
        });
        setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path, linked: true, error: undefined } : entry)));
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : 'error desconocido';
        failures.push(`${item.file.name}: ${detail}`);
        setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path, error: detail } : entry)));
      }
    }
    return { failures, latest };
  }

  async function submitEdit() {
    if (!baseline) return;
    if (!fieldsValid) {
      setMessage('Captura fecha, un concepto (mínimo 3 caracteres) y un importe mayor que cero con hasta 4 decimales.');
      return;
    }
    const update = changes();
    if (!Object.keys(update).length && !pending.length) {
      setMessage('No hay cambios que guardar.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage('');
    setRejected([]);
    let current = baseline;
    let edited = false;
    try {
      if (Object.keys(update).length) {
        current = await apiJson<IncomeResponse>(`/incomes/${baseline.id}`, {
          method: 'PATCH', body: JSON.stringify(update),
        });
        edited = true;
        setBaseline(current);
      }
      const { failures, latest } = await uploadAndLink(current.id);
      if (failures.length) throw new Error(failures.join(' · '));
      onSaved(latest ?? current, `Ingreso ${current.folio} actualizado.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'No fue posible actualizar el ingreso.';
      setMessage(edited || current !== initialData
        ? `Los datos del ingreso ${current.folio} ya se guardaron. Reintenta sólo los comprobantes pendientes. ${detail}`
        : detail);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || busy) return;
    if (editing) {
      await submitEdit();
      return;
    }
    if (!created && (!amountValid || concept.trim().length < 3)) {
      setMessage('Captura un concepto (mínimo 3 caracteres) y un importe mayor que cero con hasta 4 decimales.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage('');
    setRejected([]); // a stale "file refused" notice no longer applies once saving starts
    let income = created;
    try {
      if (!income) {
        const payload: IncomeCreate = {
          received_on: receivedOn, concept: concept.trim(), amount: amount.trim().replace(/,/g, ''),
          // A new income always starts pending; reconciliation is a later step.
          state: 'pendiente',
        };
        income = await apiJson<IncomeResponse>(`/works/${workId}/incomes`, {
          method: 'POST', body: JSON.stringify(payload),
        });
        setCreated(income);
      }
      const { failures, latest } = await uploadAndLink(income.id);
      if (failures.length) throw new Error(failures.join(' · '));
      onSaved(latest ?? income, `Ingreso ${income.folio} registrado.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'No fue posible registrar el ingreso.';
      setMessage(income
        ? `El ingreso ${income.folio} ya está guardado. Reintenta sólo los comprobantes pendientes; no se creará otro ingreso. ${detail}`
        : detail);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const title = baseline ? `Editar ingreso ${baseline.folio}` : created ? `Ingreso ${created.folio}` : 'Nuevo ingreso';
  const existing = baseline?.receipts || [];
  return <form className="panel income-form" onSubmit={submit} aria-busy={busy} aria-label={editing ? 'Editar ingreso' : 'Nuevo ingreso'}>
    <div className="panel-header"><div><h2>{title}</h2><p>{editing ? 'Corrige fecha, concepto o importe y anexa comprobantes; los actuales se conservan' : 'Anticipos, estimaciones y demás cobros de la obra'}</p></div></div>
    {baseline?.state === 'conciliado' && <p className="notice panel-notice" role="note">Este ingreso ya está conciliado. Los cambios quedan registrados en la bitácora con el valor anterior.</p>}
    {message && <p className="notice error" role="alert">{message}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-section"><fieldset className="form-grid three" aria-label="Datos del ingreso" disabled={Boolean(created)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="field">Fecha<input type="date" value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} required /></label>
        <label className="field">Concepto<input list="income-concepts" value={concept} minLength={3} maxLength={500} placeholder="Anticipo, Estimación…" onChange={(event) => setConcept(event.target.value)} required /><datalist id="income-concepts">{CONCEPT_SUGGESTIONS.map((item) => <option key={item} value={item} />)}</datalist></label>
        <label className="field">Importe<input inputMode="decimal" value={amount} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} required aria-describedby="income-amount-preview" /><span id="income-amount-preview" className="field-hint">{amountValid ? displayCents(centsFromDecimal(amount)) : 'Importe en MXN'}</span></label>
      </fieldset></div>
      <div className="form-section">
        {existing.length > 0 && <div className="existing-receipts"><h3 className="detail-section-title">Comprobantes actuales (se conservan)</h3><ul className="receipt-list">{existing.map((receipt) => <li key={receipt.id}>
          <span className="receipt-kind">{receipt.kind.toUpperCase()}</span><span>{receiptFileName(receipt.path)}</span><small>Vinculado</small>
        </li>)}</ul></div>}
        <label className={`dropzone compact${dragging ? ' dragging' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <span><span className="dropzone-icon"><UploadIcon size={22} /></span><strong>{editing ? 'Arrastra aquí comprobantes adicionales' : 'Arrastra aquí los comprobantes'}</strong><p>Transferencias o facturas en PDF o imagen · varios archivos · máximo 10 MB c/u. También puedes hacer clic para elegirlos.</p><input type="file" multiple aria-label="Comprobantes del ingreso" accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) addFiles(files); }} /></span>
        </label>
        {rejected.length > 0 && <p className="notice error" role="alert">No se agregaron: {rejected.join(' · ')}</p>}
        {receipts.length > 0 && <ul className="receipt-list">{receipts.map((item) => <li key={item.id} className={item.error ? 'failed' : undefined}>
          <span className="receipt-kind">{receiptExtension(item.file.name).toUpperCase()}</span><span>{item.file.name}</span>
          <small>{item.linked ? 'Vinculado' : item.error ? `Error: ${item.error}` : item.path ? 'Subido; falta vincular' : 'Se subirá al guardar'}</small>
          {!item.path && <button type="button" className="text-action danger" aria-label={`Quitar ${item.file.name}`} onClick={() => setReceipts((current) => current.filter((entry) => entry.id !== item.id))}>Quitar</button>}
        </li>)}</ul>}
      </div>
      <div className="form-section"><div className="header-actions">
        <button type="button" className="btn secondary" onClick={onCancel}>{created ? 'Cerrar (ingreso guardado)' : 'Cancelar'}</button>
        {editing
          ? <button type="submit" className="btn" disabled={busy || !fieldsValid || (!changed && !pending.length)}>{busy ? 'Guardando…' : 'Guardar cambios'}</button>
          : <button type="submit" className="btn" disabled={busy || (!created && (!amountValid || concept.trim().length < 3))}><PlusIcon />{busy ? 'Guardando…' : created ? `Reintentar comprobantes (${pending.length})` : 'Registrar ingreso'}</button>}
      </div></div>
    </fieldset>
  </form>;
}
