'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ExpenseLinesEditor } from '@/components/expense-lines-editor';
import { PlusIcon, UploadIcon } from '@/components/icons';
import { ReceiptAssistant } from '@/components/receipt-assistant';
import { type SupplierInitial, SupplierCreateDialog } from '@/components/supplier-directory';
import { aiErrorMessage, aiRequest } from '@/lib/ai';
import type { components } from '@/lib/api.generated';
import { apiJson } from '@/lib/auth';
import {
  type LineDraft, computeTotals, displayCents, newLine, toUnits, trimDecimal,
} from '@/lib/money';
import {
  MAX_RECEIPT_BYTES, RECEIPT_EXTENSIONS, receiptExtension, receiptPath, uploadReceipt,
} from '@/lib/receipts';

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
  permissions?: { can_manage_suppliers: boolean };
};

/** Row of the expenses list used to open the edit form; the detail is loaded by id. */
export type EditableExpense = {
  id: string; area_id: string | null; expense_item_id: string; expense_subitem_id: string;
  expense_category_id: string; supplier_id: string; proveedor: string;
  budget_item_id: string | null; fecha: string; concepto: string;
  folio: string; folio_proveedor: string | null;
  importe: string | number; comprobante_path: string | null;
};

type ExpenseDetail = components['schemas']['ExpenseResponse'];
type CfdiResult = components['schemas']['CfdiExtractionResponse'];
type ReceiptItem = {
  id: string; file: File; origin: 'upload' | 'ticket';
  /** Storage path once uploaded; kept so a retry only re-links, never re-uploads. */
  path?: string; linked: boolean; error?: string;
};

const NEW_SUPPLIER = '__new__';
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
let receiptSequence = 0;

const extension = receiptExtension;

function searchable(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('es-MX');
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

function linesFromDetail(detail: ExpenseDetail): { lines: LineDraft[]; explicitIva: bigint | null } {
  const lines = detail.lines.map((line) => newLine({
    quantity: trimDecimal(line.quantity), unit: line.unit, description: line.description,
    unitPrice: trimDecimal(line.unit_price),
    discount: Number(line.discount) ? trimDecimal(line.discount) : '', taxable: true,
  }));
  const savedIva = toUnits(trimDecimal(detail.iva), 2n) ?? 0n;
  // Prefer the per-line 16 % rule when it reproduces the saved IVA; else keep it as is.
  if (computeTotals(lines).ivaCents === savedIva) return { lines, explicitIva: null };
  if (savedIva === 0n) return { lines: lines.map((line) => ({ ...line, taxable: false })), explicitIva: null };
  return { lines, explicitIva: savedIva };
}

export function WorkExpenseForm({
  workId, catalog, expense, onSaved, onCancel,
}: {
  workId: string; catalog: WorkCatalog; expense?: EditableExpense;
  onSaved: (message: string) => void; onCancel?: () => void;
}) {
  // The NEODATA area is an optional link (Cambio 8): never preselected.
  const [areaId, setAreaId] = useState(expense?.area_id || '');
  const [neodataOpen, setNeodataOpen] = useState(Boolean(expense?.area_id));
  const [areaSearch, setAreaSearch] = useState('');
  // Partida, subpartida, categoría and proveedor start empty: every classification is
  // an intentional choice, never a silent default.
  const [partidaId, setPartidaId] = useState(expense?.expense_item_id || '');
  const availableSubitems = useMemo(
    () => catalog.expense_subitems.filter((item) => item.partida_id === partidaId),
    [catalog.expense_subitems, partidaId],
  );
  const [subpartidaId, setSubpartidaId] = useState(expense?.expense_subitem_id || '');
  const [categoryId, setCategoryId] = useState(expense?.expense_category_id || '');
  const [budgetItemId, setBudgetItemId] = useState(expense?.budget_item_id || '');
  const [suppliers, setSuppliers] = useState<CatalogOption[]>(catalog.suppliers);
  // An intentional choice: a new expense starts at "Seleccionar proveedor".
  const [supplierId, setSupplierId] = useState(expense?.supplier_id || '');
  const [supplierDialog, setSupplierDialog] = useState<{ initial?: SupplierInitial } | null>(null);
  const [spentOn, setSpentOn] = useState(expense?.fecha || localDate());
  const [concept, setConcept] = useState(expense?.concepto || '');
  const [supplierFolio, setSupplierFolio] = useState(expense?.folio_proveedor || '');
  const [lines, setLines] = useState<LineDraft[]>(() => [newLine()]);
  const [explicitIva, setExplicitIva] = useState<{ cents: bigint; label: string } | null>(null);
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>(expense ? 'loading' : 'ready');
  const [legacyIva, setLegacyIva] = useState(false);
  const [existingReceipts, setExistingReceipts] = useState<ExpenseDetail['receipts']>([]);
  const [receipts, setReceipts] = useState<ReceiptItem[]>([]);
  const [rejectedFiles, setRejectedFiles] = useState<string[]>([]);
  const [cfdi, setCfdi] = useState<{ state: 'reading' | 'ready' | 'error'; data?: CfdiResult; error?: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [createdExpenseId, setCreatedExpenseId] = useState<string | null>(null);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantKey, setAssistantKey] = useState(0);
  const totals = useMemo(() => computeTotals(lines, explicitIva?.cents ?? null), [lines, explicitIva]);
  const canManageSuppliers = Boolean(catalog.permissions?.can_manage_suppliers);
  const budgetItems = catalog.items.filter((item) => item.area_id === areaId);
  const matchingAreas = useMemo(() => filterAreas(catalog.areas, areaSearch), [areaSearch, catalog.areas]);
  const selectableAreas = useMemo(() => {
    const selected = catalog.areas.find((area) => area.id === areaId);
    if (!selected || matchingAreas.some((area) => area.id === areaId)) return matchingAreas;
    return [selected, ...matchingAreas];
  }, [areaId, catalog.areas, matchingAreas]);
  const selectableSuppliers = useMemo(() => {
    if (!expense || suppliers.some((item) => item.id === expense.supplier_id)) return suppliers;
    return [{ id: expense.supplier_id, nombre: `${expense.proveedor} · histórico` }, ...suppliers];
  }, [suppliers, expense]);
  const selectedArea = catalog.areas.find((area) => area.id === areaId);
  const selectedBudgetItem = budgetItems.find((item) => item.budget_item_id === budgetItemId);
  const pendingReceipts = receipts.filter((item) => !item.linked);
  const blocked = busy || assistantBusy || cfdi?.state === 'reading' || detailState !== 'ready';

  // Editing: load header, lines and receipts (the list row only has the header).
  useEffect(() => {
    if (!expense) return;
    let cancelled = false;
    apiJson<ExpenseDetail>(`/expenses/${expense.id}`).then((detail) => {
      if (cancelled) return;
      const loaded = linesFromDetail(detail);
      setLines(loaded.lines);
      setExplicitIva(loaded.explicitIva === null ? null : { cents: loaded.explicitIva, label: 'registrado' });
      setLegacyIva(!detail.iva_breakdown);
      setConcept(detail.concept);
      setSupplierFolio(detail.supplier_folio || '');
      setSpentOn(detail.spent_on);
      setExistingReceipts(detail.receipts);
      setDetailState('ready');
    }).catch((reason: Error) => {
      if (cancelled) return;
      setMessage(reason.message);
      setDetailState('error');
    });
    return () => { cancelled = true; };
  }, [expense]);

  function changeLines(next: LineDraft[]) {
    setLines(next);
    // Editing the concepts invalidates an IVA taken from a document: back to the 16 % rule.
    setExplicitIva(null);
  }

  function changeAreaSearch(value: string) {
    setAreaSearch(value);
    const matches = filterAreas(catalog.areas, value);
    const match = matches[0];
    if (value.trim() && matches.length === 1 && match && match.id !== areaId) {
      setAreaId(match.id);
      setBudgetItemId('');
    }
  }

  function clearNeodataLink() {
    setAreaId('');
    setBudgetItemId('');
    setAreaSearch('');
  }

  function changePartida(value: string) {
    setPartidaId(value);
    // A partida with a single subpartida leaves nothing to choose; otherwise pick explicitly.
    const options = catalog.expense_subitems.filter((item) => item.partida_id === value);
    setSubpartidaId(options.length === 1 ? options[0]!.id : '');
  }

  function changeSupplier(value: string) {
    if (value === NEW_SUPPLIER) {
      setSupplierDialog({});
      return;
    }
    setSupplierId(value);
  }

  function supplierCreated(created: { id: string; nombre: string }) {
    setSuppliers((current) => [...current, created].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-MX')));
    setSupplierId(created.id);
    setSupplierDialog(null);
    setMessage('');
  }

  async function readCfdi(file: File) {
    setCfdi({ state: 'reading' });
    const body = new FormData();
    body.append('file', file, file.name);
    body.append('work_id', workId);
    try {
      const data = await aiRequest<CfdiResult>('/expenses/extract-xml', { method: 'POST', body }, {
        413: 'El XML supera el límite de 2 MB.', 415: 'El archivo no es un XML de CFDI.',
        422: 'El XML no es un CFDI válido del SAT.', 503: 'No fue posible leer el CFDI en este momento.',
      });
      setCfdi({ state: 'ready', data });
    } catch (reason) {
      setCfdi({ state: 'error', error: reason instanceof Error ? reason.message : aiErrorMessage(503) });
    }
  }

  function addFiles(files: File[], origin: ReceiptItem['origin'] = 'upload') {
    const accepted: ReceiptItem[] = [];
    const rejected: string[] = [];
    for (const file of files) {
      if (!RECEIPT_EXTENSIONS[extension(file.name)]) rejected.push(`${file.name}: formato no permitido`);
      else if (file.size > MAX_RECEIPT_BYTES) rejected.push(`${file.name}: supera 10 MB`);
      else {
        receiptSequence += 1;
        accepted.push({ id: `receipt-${receiptSequence}`, file, origin, linked: false });
      }
    }
    setRejectedFiles(rejected);
    setReceipts((current) => [
      ...(origin === 'ticket' ? current.filter((item) => item.origin !== 'ticket' || item.path) : current),
      ...accepted,
    ]);
    const xml = accepted.find((item) => extension(item.file.name) === 'xml');
    if (xml) void readCfdi(xml.file);
  }

  function removeReceipt(id: string) {
    setReceipts((current) => current.filter((item) => item.id !== id || item.path));
  }

  function applyCfdi(data: CfdiResult) {
    const draft = data.expense;
    setLines(draft.lines.map((line) => newLine({
      quantity: trimDecimal(line.quantity), unit: line.unit, description: line.description,
      unitPrice: trimDecimal(line.unit_price),
      discount: Number(line.discount) ? trimDecimal(line.discount) : '', taxable: true,
    })));
    setExplicitIva({ cents: toUnits(trimDecimal(draft.iva), 2n) ?? 0n, label: 'CFDI' });
    if (draft.supplier_folio) setSupplierFolio(draft.supplier_folio);
    if (!concept.trim()) setConcept(draft.concept);
    if (data.issued_at) setSpentOn(data.issued_at.slice(0, 10));
    if (data.supplier && suppliers.some((item) => item.id === data.supplier?.id)) setSupplierId(data.supplier.id);
  }

  async function uploadAndLink(expenseId: string, items: ReceiptItem[]): Promise<string[]> {
    const failures: string[] = [];
    for (const item of items) {
      if (item.linked) continue;
      let path = item.path;
      try {
        if (!path) {
          const candidate = receiptPath(workId, expenseId, item.id, item.file);
          await uploadReceipt(candidate, item.file);
          path = candidate;
          // Remember the path: if linking fails, the retry re-links without re-uploading.
          setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path } : entry)));
        }
        await apiJson(`/expenses/${expenseId}/receipt`, { method: 'PATCH', body: JSON.stringify({ path }) });
        setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path, linked: true, error: undefined } : entry)));
      } catch (reason) {
        const detail = reason instanceof Error ? reason.message : 'error desconocido';
        failures.push(`${item.file.name}: ${detail}`);
        setReceipts((current) => current.map((entry) => (entry.id === item.id ? { ...entry, path, error: detail } : entry)));
      }
    }
    return failures;
  }

  function resetForNextExpense() {
    setCreatedExpenseId(null);
    setReceipts([]);
    setRejectedFiles([]);
    setCfdi(null);
    setAssistantKey((value) => value + 1);
    setLines([newLine()]);
    setExplicitIva(null);
    setConcept('');
    setSupplierFolio('');
    setSpentOn(localDate());
    setAreaSearch('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // A ref also guards submissions before React has rendered the disabled controls.
    if (submitting.current || blocked) return;
    if (!createdExpenseId && !totals.valid) {
      setMessage('Revisa los conceptos: cada renglón necesita cantidad, unidad, descripción y precio válidos.');
      return;
    }
    submitting.current = true;
    setBusy(true);
    setMessage('');
    let savedExpenseId = createdExpenseId;
    try {
      if (!savedExpenseId) {
        const payload = {
          ...(expense ? {} : { work_id: workId }),
          area_id: areaId || null,
          expense_item_id: partidaId,
          expense_subitem_id: subpartidaId,
          expense_category_id: categoryId,
          budget_item_id: budgetItemId || null,
          supplier_id: supplierId,
          spent_on: spentOn,
          concept: concept.trim(),
          supplier_folio: supplierFolio.trim() || null,
          lines: lines.map((line) => ({
            quantity: line.quantity.trim().replace(/,/g, ''),
            unit: line.unit.trim(),
            description: line.description.trim(),
            unit_price: line.unitPrice.trim().replace(/,/g, ''),
            discount: line.discount.trim().replace(/,/g, '') || '0',
          })),
          iva: totals.ivaForServer,
        };
        const saved = await apiJson<ExpenseDetail>(expense ? `/expenses/${expense.id}` : '/expenses', {
          method: expense ? 'PATCH' : 'POST', body: JSON.stringify(payload),
        });
        savedExpenseId = saved.id;
        setCreatedExpenseId(saved.id);
      }
      const failures = await uploadAndLink(savedExpenseId, receipts);
      if (failures.length) throw new Error(failures.join(' · '));
      const saved = expense ? 'Gasto corregido correctamente.' : 'Gasto guardado como pendiente.';
      resetForNextExpense();
      onSaved(saved);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'No fue posible completar la operación.';
      setMessage(savedExpenseId
        ? `El gasto ya está guardado. Reintenta sólo los comprobantes pendientes; no se creará otro gasto. ${detail}`
        : detail);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const cfdiData = cfdi?.state === 'ready' ? cfdi.data : undefined;
  const cfdiSupplierInList = Boolean(cfdiData?.supplier && suppliers.some((item) => item.id === cfdiData.supplier?.id));

  return <form className="panel work-expense-form" onSubmit={submit} aria-busy={busy}>
    <div className="panel-header"><div><h2>{expense ? `Corregir gasto ${expense.folio}` : 'Nuevo gasto'}</h2><p>Cabecera, conceptos y comprobantes</p></div></div>
    {message && <p className="notice error" role="alert">{message}</p>}
    {detailState === 'loading' && <p role="status">Cargando conceptos del gasto…</p>}
    {legacyIva && <p className="notice">Este gasto se registró sin desglose de IVA. Al guardar, el IVA se desglosará con la regla del 16 % incluido.</p>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {!expense && <div className="form-section"><ReceiptAssistant key={assistantKey} disabled={Boolean(createdExpenseId)} onBusyChange={setAssistantBusy}
      onFile={(file) => { if (file) addFiles([file], 'ticket'); else setReceipts((current) => current.filter((item) => item.origin !== 'ticket' || item.path)); }}
      onApply={({ lines: ticketLines, concept: ticketConcept }) => {
        // The user can keep editing every field afterwards (manual fallback).
        if (ticketLines.length) changeLines(ticketLines);
        if (!concept.trim() && ticketConcept) setConcept(ticketConcept);
      }} /></div>}
    <div className="form-section"><fieldset className="form-grid four" aria-label="Datos del gasto" disabled={Boolean(createdExpenseId)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className="field">Partida<select aria-label="Partida" value={partidaId} onChange={(event) => changePartida(event.target.value)} required><option value="">Seleccionar partida</option>{catalog.expense_partidas.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Subpartida<select aria-label="Subpartida" value={subpartidaId} disabled={!partidaId} onChange={(event) => setSubpartidaId(event.target.value)} required><option value="">{partidaId ? 'Seleccionar subpartida' : 'Primero elige una partida'}</option>{availableSubitems.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Categoría<select aria-label="Categoría" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required><option value="">Seleccionar categoría</option>{catalog.expense_categories.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Proveedor<select aria-label="Proveedor" value={supplierId} onChange={(event) => changeSupplier(event.target.value)} required><option value="">Seleccionar proveedor</option>{selectableSuppliers.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}{canManageSuppliers && <option value={NEW_SUPPLIER}>+ Nuevo proveedor</option>}</select></label>
      <label className="field span-2">Fecha<input name="spent_on" type="date" value={spentOn} onChange={(event) => setSpentOn(event.target.value)} required /></label>
      <label className="field span-2">Folio del proveedor<input name="supplier_folio" value={supplierFolio} maxLength={120} onChange={(event) => setSupplierFolio(event.target.value)} placeholder="Factura o nota, p. ej. A-123" /></label>
      <label className="field full">Concepto general<textarea name="concept" value={concept} minLength={3} maxLength={500} onChange={(event) => setConcept(event.target.value)} required /></label>
      <div className="full neodata-link">
        <button type="button" className="neodata-toggle" aria-expanded={neodataOpen} aria-controls="neodata-link-body" onClick={() => setNeodataOpen((open) => !open)}>
          <span><strong>Vincular a NEODATA (Opcional)</strong><small data-testid="neodata-summary">{selectedArea ? `${selectedArea.ruta.join(' › ')}${selectedBudgetItem ? ` · ${selectedBudgetItem.codigo}` : ''}` : 'Sin área específica'}</small></span>
          <span className="collapsible-chevron" aria-hidden="true" />
        </button>
        <div id="neodata-link-body" className="neodata-link-body" hidden={!neodataOpen}>{neodataOpen && <>
          <p className="field-hint">El gasto se controla por partida, subpartida y categoría. El área y la partida NEODATA son un dato de referencia opcional.</p>
          <div className="form-grid">
        <label className="field area-picker">Área NEODATA<span className="field-hint">{areaSearch ? `${matchingAreas.length} coincidencia${matchingAreas.length === 1 ? '' : 's'} de ` : 'Busca dentro de '}{catalog.areas.filter((area) => area.seleccionable).length} rutas</span><input aria-label="Buscar área NEODATA" type="search" placeholder="Ej. cimentación sótano" value={areaSearch} onChange={(event) => changeAreaSearch(event.target.value)} /><select aria-label="Área NEODATA" value={areaId} onChange={(event) => { setAreaId(event.target.value); setBudgetItemId(''); }}><option value="">Sin área específica</option>{selectableAreas.map((area) => <option key={area.id} value={area.id}>{area.ruta.join(' › ')}</option>)}</select>{areaSearch && matchingAreas.length === 0 && <small className="field-error">No hay áreas que coincidan.</small>}</label>
        <label className="field">Partida NEODATA<select aria-label="Partida NEODATA" value={budgetItemId} disabled={!areaId} onChange={(event) => setBudgetItemId(event.target.value)}><option value="">{areaId ? 'Sin vínculo específico' : 'Primero elige un área'}</option>{budgetItems.map((item) => <option key={item.budget_item_id} value={item.budget_item_id}>{item.codigo} · {item.descripcion} · {money.format(Number(item.presupuesto))}</option>)}</select></label>
          </div>
          {areaId && <button type="button" className="text-action danger" onClick={clearNeodataLink}>Quitar vínculo</button>}
        </>}</div>
      </div>
      <div className="full"><ExpenseLinesEditor lines={lines} totals={totals} explicitIvaLabel={explicitIva?.label} onChange={changeLines} />
        {explicitIva && <p className="field-hint">IVA tomado del {explicitIva.label === 'CFDI' ? 'CFDI' : 'gasto registrado'}. Si modificas los conceptos se recalcula con la regla del 16 %.</p>}</div>
    </fieldset>
      <section className="receipt-files" aria-label="Comprobantes del gasto">
        <label className="dropzone compact"><span><span className="dropzone-icon"><UploadIcon size={22} /></span><strong>Comprobantes (PDF, XML, imágenes)</strong><p>Puedes adjuntar varios. Si incluyes el XML del CFDI, sus datos se leen automáticamente.</p><input type="file" multiple aria-label="Comprobantes" accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,application/pdf,application/xml,text/xml,image/jpeg,image/png,image/webp" onChange={(event) => { const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = ''; if (files.length) addFiles(files); }} /></span></label>
        {rejectedFiles.length > 0 && <p className="notice error" role="alert">No se agregaron: {rejectedFiles.join(' · ')}</p>}
        {(existingReceipts.length > 0 || receipts.length > 0) && <ul className="receipt-list">
          {existingReceipts.map((item) => <li key={item.id}><span className="receipt-kind">{item.kind.toUpperCase()}</span><span>{item.path.split('/').pop()}</span><small>Ya vinculado</small></li>)}
          {receipts.map((item) => <li key={item.id} className={item.error ? 'failed' : undefined}><span className="receipt-kind">{extension(item.file.name).toUpperCase()}</span><span>{item.file.name}{item.origin === 'ticket' ? ' · foto del ticket' : ''}</span><small>{item.linked ? 'Vinculado' : item.error ? `Error: ${item.error}` : item.path ? 'Subido; falta vincular' : 'Se subirá al guardar'}</small>{!item.path && <button type="button" className="text-action danger" aria-label={`Quitar ${item.file.name}`} onClick={() => removeReceipt(item.id)}>Quitar</button>}</li>)}
        </ul>}
        {cfdi?.state === 'reading' && <p role="status">Leyendo CFDI…</p>}
        {cfdi?.state === 'error' && <p className="notice error" role="alert">{cfdi.error} El archivo se adjuntará igual como comprobante.</p>}
        {cfdiData && <div className="cfdi-summary" role="region" aria-label="Datos del CFDI">
          <div className="receipt-summary-header"><h3>CFDI {cfdiData.series ? `${cfdiData.series}-` : ''}{cfdiData.folio || ''}</h3><small>{cfdiData.uuid || 'Sin timbre'}</small></div>
          <p><strong>{cfdiData.issuer.name || 'Emisor'}</strong> · RFC {cfdiData.issuer.rfc} · {cfdiData.concepts.length} concepto{cfdiData.concepts.length === 1 ? '' : 's'} · Total {displayCents(toUnits(trimDecimal(cfdiData.total), 2n) ?? null)} · IVA {displayCents(toUnits(trimDecimal(cfdiData.iva), 2n) ?? null)}</p>
          {cfdiData.warnings.length > 0 && <div className="notice" role="status"><strong>Revisa antes de guardar.</strong><ul>{cfdiData.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
          {cfdiData.supplier
            ? cfdiSupplierInList
              ? <p className="field-hint">Proveedor encontrado: {cfdiData.supplier.name}. Se seleccionará al usar los datos.</p>
              : <p className="notice">{cfdiData.supplier.name} existe en el directorio pero no está asignado a esta obra. <Link className="text-action" href={`/proveedores/${cfdiData.supplier.id}`}>Asígnalo desde su ficha</Link>.</p>
            : <p className="notice">El emisor ({cfdiData.issuer.rfc}) no está en el directorio.{canManageSuppliers && <> <button type="button" className="text-action" onClick={() => setSupplierDialog({ initial: { name: cfdiData.issuer.name || cfdiData.issuer.rfc, legal_name: cfdiData.issuer.name || '', tax_id: cfdiData.issuer.rfc } })}>Dar de alta con los datos del CFDI</button></>}</p>}
          <button type="button" className="btn secondary" disabled={Boolean(createdExpenseId)} onClick={() => applyCfdi(cfdiData)}>Usar datos del CFDI</button>
        </div>}
      </section>
    {!expense && suppliers.length === 0 ? <p className="notice">No hay proveedores asignados a esta obra. {canManageSuppliers ? <button type="button" className="text-action" onClick={() => setSupplierDialog({})}>+ Nuevo proveedor</button> : <Link className="text-action" href="/proveedores">Solicita a administración que asigne uno</Link>}</p> : null}</div>
    <div className="form-section"><div className="header-actions">{onCancel && <button className="btn secondary" type="button" onClick={onCancel}>{createdExpenseId ? 'Cerrar (gasto guardado)' : 'Cancelar'}</button>}<button type="submit" className="btn" disabled={blocked || !partidaId || !subpartidaId || !categoryId || !supplierId || (!createdExpenseId && !totals.valid)}><PlusIcon />{busy ? 'Guardando…' : createdExpenseId ? `Reintentar comprobantes (${pendingReceipts.length})` : expense ? 'Guardar corrección' : 'Guardar pendiente'}</button></div></div>
    </fieldset>
    {supplierDialog && <SupplierCreateDialog workId={workId} initial={supplierDialog.initial} onClose={() => setSupplierDialog(null)} onCreated={supplierCreated} />}
  </form>;
}
