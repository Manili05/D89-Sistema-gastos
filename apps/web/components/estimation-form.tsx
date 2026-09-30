'use client';

import { type FormEvent, useState } from 'react';
import { apiJson } from '@/lib/auth';
import {
  type Estimation, type EstimationDraft, type EstimationKind, KIND_LABEL, type Subcontract,
  balances, previewEstimation,
} from '@/lib/estimation';
import { displayCents, formatCents, trimDecimal } from '@/lib/money';

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const money = (value: bigint | null) => (value === null ? '—' : displayCents(value));

/**
 * Register (POST) or correct a draft (PUT) estimation. Retention and net are shown live,
 * with the server's exact rule, so the admin knows what will be paid before saving.
 */
export function EstimationForm({ contract, estimations, initial, onSaved, onCancel }: {
  contract: Subcontract;
  estimations: Estimation[];
  initial?: Estimation;
  onSaved: (estimation: Estimation, message: string) => void;
  onCancel: () => void;
}) {
  const hasFiniquito = estimations.some((item) => item.kind === 'finiquito' && item.id !== initial?.id);
  const [date, setDate] = useState(initial?.estimated_on || localDate());
  const [draft, setDraft] = useState<EstimationDraft>(() => ({
    kind: initial?.kind || 'avance',
    gross: initial ? trimDecimal(initial.gross_amount) : '',
    amortization: initial && Number(initial.advance_amortization) ? trimDecimal(initial.advance_amortization) : '',
    additions: initial && Number(initial.additions) ? trimDecimal(initial.additions) : '',
    deductions: initial && Number(initial.deductions) ? trimDecimal(initial.deductions) : '',
    notes: initial?.adjustment_notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const preview = previewEstimation(draft, contract, estimations, initial?.id);
  const pending = balances(contract, estimations, initial?.id);
  const advance = draft.kind === 'anticipo';
  const set = (field: keyof EstimationDraft) => (value: string) => setDraft((current) => ({ ...current, [field]: value }));

  function changeKind(kind: EstimationKind) {
    setDraft((current) => ({
      ...current, kind,
      // An anticipo carries no adjustments; a finiquito amortizes everything pending.
      ...(kind === 'anticipo' ? { amortization: '', additions: '', deductions: '' } : {}),
      ...(kind === 'finiquito' && pending.amortizable > 0n ? { amortization: trimDecimal(formatCents(pending.amortizable)) } : {}),
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || preview.errors.length) return;
    setBusy(true);
    setMessage('');
    const clean = (value: string) => value.trim().replace(/,/g, '') || '0';
    const payload = {
      estimated_on: date, kind: draft.kind, gross_amount: clean(draft.gross),
      advance_amortization: clean(draft.amortization), additions: clean(draft.additions),
      deductions: clean(draft.deductions), adjustment_notes: draft.notes.trim() || null,
    };
    try {
      const path = `/subcontracts/${contract.id}/estimations${initial ? `/${initial.id}` : ''}`;
      const saved = await apiJson<Estimation>(path, { method: initial ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      onSaved(saved, initial ? `Estimación ${saved.folio} corregida.` : `Estimación ${saved.folio} registrada como borrador.`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'No fue posible guardar la estimación.');
    } finally {
      setBusy(false);
    }
  }

  return <form className="estimation-form" onSubmit={submit} aria-busy={busy} aria-label={initial ? 'Corregir estimación' : 'Nueva estimación'}>
    <h3 className="breakdown-title">{initial ? `Corregir ${initial.folio}` : 'Nueva estimación'} <small>queda en borrador hasta pagarla</small></h3>
    {message && <p className="notice error" role="alert">{message}</p>}
    <fieldset disabled={busy} className="estimation-grid">
      <div className="estimation-inputs">
        <label className="field">Tipo<select aria-label="Tipo" value={draft.kind} onChange={(event) => changeKind(event.target.value as EstimationKind)}>
          {(['anticipo', 'avance', 'finiquito'] as const).map((kind) => <option key={kind} value={kind} disabled={kind === 'finiquito' && hasFiniquito}>{KIND_LABEL[kind]}</option>)}
        </select></label>
        <label className="field">Fecha<input type="date" aria-label="Fecha" value={date} onChange={(event) => setDate(event.target.value)} required /></label>
        <label className="field">Importe bruto<input aria-label="Importe bruto" inputMode="decimal" placeholder="0.00" value={draft.gross} onChange={(event) => set('gross')(event.target.value)} required /></label>
        <label className="field">Amortización de anticipo<input aria-label="Amortización de anticipo" inputMode="decimal" placeholder="0.00" value={draft.amortization} disabled={advance} onChange={(event) => set('amortization')(event.target.value)} aria-describedby="amortizable-hint" /><span id="amortizable-hint" className="field-hint">Anticipo pagado pendiente: {displayCents(pending.amortizable)}</span></label>
        <label className="field">Aditivas<input aria-label="Aditivas" inputMode="decimal" placeholder="0.00" value={draft.additions} disabled={advance} onChange={(event) => set('additions')(event.target.value)} /></label>
        <label className="field">Deductivas<input aria-label="Deductivas" inputMode="decimal" placeholder="0.00" value={draft.deductions} disabled={advance} onChange={(event) => set('deductions')(event.target.value)} /></label>
        <label className="field full">Notas de ajustes<textarea aria-label="Notas de ajustes" value={draft.notes} maxLength={2000} placeholder="Justifica aditivas (trabajos extra) o deductivas (daños, penalizaciones)" onChange={(event) => set('notes')(event.target.value)} /></label>
      </div>
      <dl className="estimation-preview" aria-label="Cálculo del pago" aria-live="polite">
        <div><dt>Importe bruto</dt><dd data-testid="preview-gross">{money(preview.gross)}</dd></div>
        <div><dt>+ Aditivas</dt><dd data-testid="preview-additions">{money(preview.additions)}</dd></div>
        <div><dt>− Deductivas</dt><dd data-testid="preview-deductions">{money(preview.deductions)}</dd></div>
        <div><dt>− Amortización de anticipo</dt><dd data-testid="preview-amortization">{money(preview.amortization)}</dd></div>
        <div><dt>− Retención de garantía ({Number(contract.retention_percent)} %)</dt><dd data-testid="preview-retention">{displayCents(preview.retention)}</dd></div>
        <div className="net"><dt>= Neto a pagar</dt><dd data-testid="preview-net">{money(preview.net)}</dd></div>
      </dl>
    </fieldset>
    {preview.errors.length > 0 && (draft.gross.trim() || draft.amortization || draft.additions || draft.deductions) && <ul className="notice error estimation-errors" role="alert">{preview.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
    <div className="header-actions">
      <button type="button" className="btn secondary" onClick={onCancel}>Cancelar</button>
      <button type="submit" className="btn" disabled={busy || preview.errors.length > 0}>{busy ? 'Guardando…' : initial ? 'Guardar corrección' : 'Registrar estimación'}</button>
    </div>
  </form>;
}
