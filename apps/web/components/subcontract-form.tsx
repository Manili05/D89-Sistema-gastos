'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { PlusIcon } from '@/components/icons';
import type { WorkCatalog } from '@/components/work-expense-form';
import { apiJson } from '@/lib/auth';
import type { Subcontract } from '@/lib/estimation';
import { centsFromDecimal, displayCents, toUnits, trimDecimal } from '@/lib/money';

/**
 * Register (POST /works/{id}/subcontracts) or edit (PATCH /subcontracts/{id}) a
 * piecework contract. The category is always MANO DE OBRA (set by the server). With
 * estimations already recorded, supplier, classification and retention are locked.
 */
export function SubcontractForm({ workId, catalog, initial, locked = false, onSaved, onCancel }: {
  workId: string;
  catalog: WorkCatalog;
  initial?: Subcontract;
  /** Estimations exist: supplier, partida/subpartida and % can no longer change. */
  locked?: boolean;
  onSaved: (item: Subcontract, message: string) => void;
  onCancel: () => void;
}) {
  const [supplierId, setSupplierId] = useState(initial?.supplier_id || '');
  const [partidaId, setPartidaId] = useState(initial?.expense_item_id || '');
  const [subpartidaId, setSubpartidaId] = useState(initial?.expense_subitem_id || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [amount, setAmount] = useState(initial ? trimDecimal(initial.contracted_amount) : '');
  const [percent, setPercent] = useState(initial ? trimDecimal(initial.retention_percent) || '0' : '0');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const subitems = useMemo(() => catalog.expense_subitems.filter((item) => item.partida_id === partidaId), [catalog.expense_subitems, partidaId]);
  const suppliers = useMemo(() => {
    if (!initial?.supplier_id || catalog.suppliers.some((item) => item.id === initial.supplier_id)) return catalog.suppliers;
    return [{ id: initial.supplier_id, nombre: `${initial.supplier_name} · histórico` }, ...catalog.suppliers];
  }, [catalog.suppliers, initial]);
  const amountCents = toUnits(amount.replace(/,/g, ''), 2n);
  const percentUnits = toUnits(percent || '0', 2n);
  const amountValid = amountCents !== null && amountCents > 0n;
  const percentValid = percentUnits !== null && percentUnits <= 10000n;
  const valid = Boolean(supplierId && partidaId && subpartidaId) && description.trim().length >= 3 && amountValid && percentValid;

  function changePartida(value: string) {
    setPartidaId(value);
    const options = catalog.expense_subitems.filter((item) => item.partida_id === value);
    setSubpartidaId(options.length === 1 ? options[0]!.id : '');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setMessage('');
    const full = {
      supplier_id: supplierId, expense_item_id: partidaId, expense_subitem_id: subpartidaId,
      description: description.trim(), contracted_amount: amount.trim().replace(/,/g, ''),
      retention_percent: percent.trim() || '0',
    };
    try {
      let saved: Subcontract;
      if (initial) {
        // Only what changed; the server keeps the rest.
        const changes: Record<string, string> = {};
        if (full.supplier_id !== initial.supplier_id) changes.supplier_id = full.supplier_id;
        if (full.expense_item_id !== initial.expense_item_id || full.expense_subitem_id !== initial.expense_subitem_id) {
          changes.expense_item_id = full.expense_item_id;
          changes.expense_subitem_id = full.expense_subitem_id;
        }
        if (full.description !== initial.description) changes.description = full.description;
        if (amountCents !== centsFromDecimal(initial.contracted_amount)) changes.contracted_amount = full.contracted_amount;
        if (percentUnits !== toUnits(trimDecimal(initial.retention_percent) || '0', 2n)) changes.retention_percent = full.retention_percent;
        if (!Object.keys(changes).length) { setMessage('No hay cambios que guardar.'); return; }
        saved = await apiJson<Subcontract>(`/subcontracts/${initial.id}`, { method: 'PATCH', body: JSON.stringify(changes) });
        onSaved(saved, `Subcontrato ${saved.folio} actualizado.`);
      } else {
        saved = await apiJson<Subcontract>(`/works/${workId}/subcontracts`, { method: 'POST', body: JSON.stringify(full) });
        onSaved(saved, `Subcontrato ${saved.folio} registrado.`);
      }
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'No fue posible guardar el subcontrato.');
    } finally {
      setBusy(false);
    }
  }

  return <form className="panel income-form" onSubmit={submit} aria-busy={busy} aria-label={initial ? 'Editar subcontrato' : 'Nuevo subcontrato'}>
    <div className="panel-header"><div><h2>{initial ? `Editar subcontrato ${initial.folio}` : 'Nuevo subcontrato'}</h2><p>Destajo de mano de obra o servicios · la categoría es siempre MANO DE OBRA</p></div></div>
    {locked && <p className="notice panel-notice" role="note">Este subcontrato ya tiene estimaciones: proveedor, partida, subpartida y % de garantía ya no se pueden cambiar.</p>}
    {message && <p className="notice error" role="alert">{message}</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-section"><div className="form-grid four">
        <label className="field">Proveedor<select aria-label="Proveedor" value={supplierId} disabled={locked} onChange={(event) => setSupplierId(event.target.value)} required><option value="">Seleccionar proveedor</option>{suppliers.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
        <label className="field">Partida<select aria-label="Partida" value={partidaId} disabled={locked} onChange={(event) => changePartida(event.target.value)} required><option value="">Seleccionar partida</option>{catalog.expense_partidas.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
        <label className="field">Subpartida<select aria-label="Subpartida" value={subpartidaId} disabled={locked || !partidaId} onChange={(event) => setSubpartidaId(event.target.value)} required><option value="">{partidaId ? 'Seleccionar subpartida' : 'Primero elige una partida'}</option>{subitems.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
        <label className="field">Categoría<input aria-label="Categoría" value="MANO DE OBRA" readOnly disabled /></label>
        <label className="field span-2">Importe contratado<input aria-label="Importe contratado" inputMode="decimal" value={amount} placeholder="0.00" onChange={(event) => setAmount(event.target.value)} required aria-describedby="subcontract-amount-hint" /><span id="subcontract-amount-hint" className="field-hint">{amountValid ? displayCents(amountCents) : 'MXN, hasta 2 decimales'}</span></label>
        <label className="field span-2">% Fondo de garantía<input aria-label="% Fondo de garantía" inputMode="decimal" value={percent} disabled={locked} onChange={(event) => setPercent(event.target.value)} aria-describedby="subcontract-percent-hint" /><span id="subcontract-percent-hint" className={percentValid ? 'field-hint' : 'field-error'}>{percentValid ? 'Se retiene de cada avance y del finiquito (0 a 100 %)' : 'Entre 0 y 100, hasta 2 decimales'}</span></label>
        <label className="field full">Descripción (alcance del trabajo)<textarea aria-label="Descripción" value={description} minLength={3} maxLength={3000} onChange={(event) => setDescription(event.target.value)} required placeholder="Ej. colocación de block y aplanados en muros perimetrales" /></label>
      </div></div>
      {catalog.suppliers.length === 0 && <p className="notice panel-notice">No hay proveedores asignados a esta obra; asígnalos desde el directorio de proveedores.</p>}
      <div className="form-section"><div className="header-actions">
        <button type="button" className="btn secondary" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="btn" disabled={busy || !valid}>{initial ? (busy ? 'Guardando…' : 'Guardar cambios') : <><PlusIcon />{busy ? 'Guardando…' : 'Registrar subcontrato'}</>}</button>
      </div></div>
    </fieldset>
  </form>;
}
