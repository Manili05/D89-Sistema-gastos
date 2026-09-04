'use client';

import Link from 'next/link';
import { type FormEvent, useMemo, useState } from 'react';
import { PlusIcon } from '@/components/icons';
import { apiJson, getSupabaseBrowserClient } from '@/lib/auth';

export type CatalogOption = { id: string; nombre: string };
export type WorkCatalog = {
  areas: (CatalogOption & { ruta: string[]; nivel: number; seleccionable: boolean })[];
  items: (CatalogOption & {
    budget_item_id: string; area_id: string; codigo: string; descripcion: string;
    presupuesto: string | number;
  })[];
  expense_partidas: CatalogOption[];
  expense_subitems: (CatalogOption & { partida_id: string })[];
  expense_categories: CatalogOption[];
  suppliers: CatalogOption[];
};

export type EditableExpense = {
  id: string; area_id: string; expense_item_id: string; expense_subitem_id: string;
  expense_category_id: string; supplier_id: string; proveedor: string;
  budget_item_id: string | null; fecha: string; concepto: string; folio: string | null;
  importe: string | number; comprobante_path: string | null;
};

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

function searchable(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-MX');
}

function filterAreas(areas: WorkCatalog['areas'], query: string): WorkCatalog['areas'] {
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  const selectable = areas.filter((area) => area.seleccionable);
  if (!terms.length) return selectable;
  return selectable.filter((area) => {
    const path = searchable(area.ruta.join(' '));
    return terms.every((term) => path.includes(term));
  });
}

function localDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export function WorkExpenseForm({
  workId, catalog, expense, onSaved, onCancel,
}: {
  workId: string; catalog: WorkCatalog; expense?: EditableExpense;
  onSaved: (message: string) => void; onCancel?: () => void;
}) {
  const firstArea = catalog.areas.find((area) => area.seleccionable)?.id || '';
  const [areaId, setAreaId] = useState(expense?.area_id || firstArea);
  const [areaSearch, setAreaSearch] = useState('');
  const [partidaId, setPartidaId] = useState(
    expense?.expense_item_id || catalog.expense_partidas[0]?.id || '',
  );
  const availableSubitems = useMemo(
    () => catalog.expense_subitems.filter((item) => item.partida_id === partidaId),
    [catalog.expense_subitems, partidaId],
  );
  const [subpartidaId, setSubpartidaId] = useState(
    expense?.expense_subitem_id
      || catalog.expense_subitems.find((item) => item.partida_id === partidaId)?.id || '',
  );
  const [categoryId, setCategoryId] = useState(
    expense?.expense_category_id || catalog.expense_categories[0]?.id || '',
  );
  const [budgetItemId, setBudgetItemId] = useState(expense?.budget_item_id || '');
  const [supplierId, setSupplierId] = useState(
    expense?.supplier_id || catalog.suppliers[0]?.id || '',
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const budgetItems = catalog.items.filter((item) => item.area_id === areaId);
  const matchingAreas = useMemo(
    () => filterAreas(catalog.areas, areaSearch),
    [areaSearch, catalog.areas],
  );
  const selectableAreas = useMemo(() => {
    const selected = catalog.areas.find((area) => area.id === areaId);
    if (!selected || matchingAreas.some((area) => area.id === areaId)) return matchingAreas;
    return [selected, ...matchingAreas];
  }, [areaId, catalog.areas, matchingAreas]);
  const selectableSuppliers = useMemo(() => {
    if (!expense || catalog.suppliers.some((item) => item.id === expense.supplier_id)) {
      return catalog.suppliers;
    }
    return [{ id: expense.supplier_id, nombre: `${expense.proveedor} · histórico` }, ...catalog.suppliers];
  }, [catalog.suppliers, expense]);

  function changeAreaSearch(value: string) {
    setAreaSearch(value);
    const matches = filterAreas(catalog.areas, value);
    const match = matches[0];
    if (value.trim() && matches.length === 1 && match && match.id !== areaId) {
      setAreaId(match.id);
      setBudgetItemId('');
    }
  }

  function changePartida(value: string) {
    setPartidaId(value);
    setSubpartidaId(
      catalog.expense_subitems.find((item) => item.partida_id === value)?.id || '',
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      const payload = {
        ...(expense ? {} : { work_id: workId }),
        area_id: areaId,
        expense_item_id: partidaId,
        expense_subitem_id: subpartidaId,
        expense_category_id: categoryId,
        budget_item_id: budgetItemId || null,
        supplier_id: supplierId,
        spent_on: form.get('spent_on'),
        concept: form.get('concept'),
        folio: form.get('folio') || null,
        amount: form.get('amount'),
        ...(expense ? {} : { state: 'pendiente' }),
      };
      const saved = await apiJson<{ id: string }>(expense ? `/expenses/${expense.id}` : '/expenses', {
        method: expense ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      const receipt = form.get('receipt');
      if (receipt instanceof File && receipt.size > 0) {
        const safeName = receipt.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const path = `${workId}/${saved.id}/${Date.now()}-${safeName}`;
        const { error } = await getSupabaseBrowserClient().storage
          .from('comprobantes').upload(path, receipt, { contentType: receipt.type, upsert: false });
        if (error) throw new Error(`Movimiento guardado, pero falló el comprobante: ${error.message}`);
        await apiJson(`/expenses/${saved.id}/receipt`, {
          method: 'PATCH', body: JSON.stringify({ path }),
        });
      }
      onSaved(expense ? 'Gasto corregido correctamente.' : 'Gasto guardado como pendiente.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible guardar el gasto.');
    } finally {
      setBusy(false);
    }
  }

  return <form className="panel work-expense-form" onSubmit={submit}>
    <div className="panel-header"><div><h2>{expense ? 'Corregir gasto' : 'Nuevo gasto'}</h2><p>Clasificación operativa y vínculo presupuestal opcional</p></div></div>
    {message && <p className="notice error" role="alert">{message}</p>}
    <div className="form-section"><div className="form-grid three">
      <label className="field area-picker">Área NEODATA<span className="field-hint">{areaSearch ? `${matchingAreas.length} coincidencia${matchingAreas.length === 1 ? '' : 's'} de ` : 'Busca dentro de '}{catalog.areas.filter((area) => area.seleccionable).length} rutas</span><input aria-label="Buscar área NEODATA" type="search" placeholder="Ej. cimentación sótano" value={areaSearch} onChange={(event) => changeAreaSearch(event.target.value)} /><select aria-label="Área NEODATA" value={areaId} onChange={(event) => { setAreaId(event.target.value); setBudgetItemId(''); }} required><option value="">Seleccionar</option>{selectableAreas.map((area) => <option key={area.id} value={area.id}>{area.ruta.join(' › ')}</option>)}</select>{areaSearch && matchingAreas.length === 0 && <small className="field-error">No hay áreas que coincidan.</small>}</label>
      <label className="field">Partida<select aria-label="Partida" value={partidaId} onChange={(event) => changePartida(event.target.value)} required>{catalog.expense_partidas.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Subpartida<select aria-label="Subpartida" value={subpartidaId} onChange={(event) => setSubpartidaId(event.target.value)} required>{availableSubitems.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Categoría<select aria-label="Categoría" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>{catalog.expense_categories.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Proveedor<select aria-label="Proveedor" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} required><option value="">Seleccionar proveedor</option>{selectableSuppliers.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Partida NEODATA (opcional)<select aria-label="Partida NEODATA" value={budgetItemId} onChange={(event) => setBudgetItemId(event.target.value)}><option value="">Sin vínculo específico</option>{budgetItems.map((item) => <option key={item.budget_item_id} value={item.budget_item_id}>{item.codigo} · {item.descripcion} · {money.format(Number(item.presupuesto))}</option>)}</select></label>
      <label className="field">Fecha<input name="spent_on" type="date" defaultValue={expense?.fecha || localDate()} required /></label>
      <label className="field">Importe<input name="amount" type="number" min="0.01" step="0.01" defaultValue={expense ? String(expense.importe) : ''} required /></label>
      <label className="field">Folio<input name="folio" defaultValue={expense?.folio || ''} /></label>
      <label className="field full">Concepto<textarea name="concept" defaultValue={expense?.concepto || ''} required /></label>
      <label className="field full">Comprobante {expense?.comprobante_path ? '(ya existe; selecciona otro sólo para reemplazarlo)' : ''}<input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
    </div>{!expense && catalog.suppliers.length === 0 ? <p className="notice">No hay proveedores asignados a esta obra. <Link className="text-action" href="/proveedores">Asigna uno desde el directorio</Link> antes de registrar gastos.</p> : null}</div>
    <div className="form-section"><div className="header-actions">{onCancel && <button className="btn secondary" type="button" onClick={onCancel}>Cancelar</button>}<button className="btn" disabled={busy || !areaId || !subpartidaId || !categoryId || !supplierId}><PlusIcon />{busy ? 'Guardando…' : expense ? 'Guardar corrección' : 'Guardar pendiente'}</button></div></div>
  </form>;
}
