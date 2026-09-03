'use client';

import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { UploadIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { apiFetch, apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string; presupuesto: string };
type PreviewItem = {
  sheet: string; row: number; area: string; work_class: string; category: string | null;
  code: string; description: string; unit: string; quantity: string; unit_price: string; amount: string;
};
type PreviewData = {
  area_count: number; item_count: number; consolidated_item_count: number;
  section_total_count: number; rollup_total_count: number;
  calculated_total_without_vat: string; warnings: string[]; unclassified: unknown[];
  section_mismatches: unknown[]; items: PreviewItem[];
};
type PreviewResponse = {
  id: string; obra_id: string; estado: string; duplicate: boolean; read_only: boolean;
  work?: { id: string; nombre: string }; preview: PreviewData;
};

const PAGE_SIZE = 50;
const editableFields = ['area', 'work_class', 'category', 'code', 'description', 'unit'] as const;
type EditableField = (typeof editableFields)[number];

function money(value: string) {
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(Number(value));
}

export default function ImportPage() {
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState('nueva_version');
  const [target, setTarget] = useState<'existing' | 'new'>('existing');
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [workName, setWorkName] = useState('');
  const [workLocation, setWorkLocation] = useState('');
  const [workStartDate, setWorkStartDate] = useState('');
  const [workEndDate, setWorkEndDate] = useState('');
  const [preview, setPreview] = useState<PreviewResponse>();
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [dirtyRows, setDirtyRows] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'error' | 'success' | ''>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<Work[]>('/works').then((result) => {
      setWorks(result);
      setWorkId(result[0]?.id || '');
    }).catch((error: Error) => {
      setMessageTone('error');
      setMessage(error.message);
    });
  }, []);

  const filteredItems = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase('es');
    if (!query) return items;
    return items.filter((item) =>
      [item.code, item.description, item.area, item.work_class, item.category, item.unit]
        .filter(Boolean).some((value) => String(value).toLocaleLowerCase('es').includes(query)),
    );
  }, [filter, items]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const visibleItems = filteredItems.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function clearPreview() {
    setPreview(undefined);
    setItems([]);
    setDirtyRows(new Set());
    setFilter('');
    setPage(1);
  }

  async function responseMessage(response: Response) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: unknown };
    return typeof payload.detail === 'string'
      ? payload.detail
      : `No fue posible generar el preview (${response.status}).`;
  }

  async function generatePreview() {
    if (!file || (target === 'existing' && !workId)) return;
    if (target === 'new' && workName.trim().length < 2) {
      setMessageTone('error');
      setMessage('Captura un nombre de al menos 2 caracteres para la obra nueva.');
      return;
    }
    setBusy(true);
    setMessage('');
    setMessageTone('');
    clearPreview();
    try {
      const body = new FormData();
      body.set('import_type', target === 'new' ? 'inicial' : mode);
      body.set('file', file);
      if (target === 'existing') {
        body.set('work_id', workId);
      } else {
        body.set('work_name', workName.trim());
        if (workLocation.trim()) body.set('work_location', workLocation.trim());
        if (workStartDate) body.set('work_start_date', workStartDate);
        if (workEndDate) body.set('work_end_date', workEndDate);
      }
      const response = await apiFetch('/neodata/preview', { method: 'POST', body });
      if (!response.ok) throw new Error(await responseMessage(response));
      const payload = (await response.json()) as PreviewResponse;
      setPreview(payload);
      setItems(payload.preview.items);
      if (payload.work) {
        setWorks((current) => [{ id: payload.work!.id, nombre: payload.work!.nombre, presupuesto: '0' }, ...current]);
        setWorkId(payload.work.id);
      }
      if (payload.duplicate) {
        setMessage(payload.read_only
          ? 'Este archivo ya fue confirmado. Se muestra su preview original en modo lectura.'
          : 'Este archivo ya tenía un preview pendiente. Puedes continuar su revisión.');
      } else {
        setMessageTone('success');
        setMessage(payload.work
          ? `Obra “${payload.work.nombre}” creada y preview generado sin confirmar.`
          : 'Preview generado sin modificar el presupuesto vigente.');
      }
    } catch (error) {
      setMessageTone('error');
      setMessage(error instanceof Error ? error.message : 'No fue posible generar el preview.');
    } finally {
      setBusy(false);
    }
  }

  function editItem(index: number, field: EditableField, value: string) {
    const source = visibleItems[index];
    if (!source) return;
    const key = `${source.sheet}:${source.row}`;
    setItems((current) => current.map((item) =>
      item.sheet === source.sheet && item.row === source.row
        ? { ...item, [field]: field === 'category' ? value || null : value }
        : item,
    ));
    setDirtyRows((current) => new Set(current).add(key));
  }

  async function persistCorrections(showMessage = true) {
    if (!preview || dirtyRows.size === 0) return;
    const corrections = items.filter((item) => dirtyRows.has(`${item.sheet}:${item.row}`)).map((item) => ({
      sheet: item.sheet, row: item.row, area: item.area, work_class: item.work_class,
      category: item.category, code: item.code, description: item.description, unit: item.unit,
    }));
    const result = await apiJson<{ preview: PreviewData }>(`/neodata/imports/${preview.id}/preview`, {
      method: 'PATCH', body: JSON.stringify({ items: corrections }),
    });
    setPreview((current) => current ? { ...current, preview: result.preview } : current);
    setItems(result.preview.items);
    setDirtyRows(new Set());
    if (showMessage) {
      setMessageTone('success');
      setMessage(`${corrections.length} corrección(es) guardada(s) en el preview.`);
    }
  }

  async function saveCorrections() {
    setBusy(true);
    try {
      await persistCorrections();
    } catch (error) {
      setMessageTone('error');
      setMessage(error instanceof Error ? error.message : 'No fue posible guardar las correcciones.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPreview() {
    if (!preview || preview.read_only) return;
    setBusy(true);
    try {
      await persistCorrections(false);
      const result = await apiJson<{ version_resultante: number; item_count: number }>(
        `/neodata/imports/${preview.id}/confirm`,
        { method: 'POST', body: JSON.stringify({ confirmation: true }) },
      );
      setMessageTone('success');
      setMessage(`Presupuesto v${result.version_resultante} confirmado con ${result.item_count} partidas.`);
      clearPreview();
      setFile(undefined);
    } catch (error) {
      setMessageTone('error');
      setMessage(error instanceof Error ? error.message : 'No fue posible confirmar.');
    } finally {
      setBusy(false);
    }
  }

  const canGenerate = Boolean(file && (target === 'existing' ? workId : workName.trim().length >= 2));

  return (
    <AppShell active="/admin/importar">
      <PageHeader eyebrow="Portal administrador" title="Importar presupuesto" description="Carga el Excel de NEODATA, revisa la interpretación y confirma solo cuando todo esté correcto." />
      <div className="steps" aria-label="Progreso de importación"><div className="step active"><span>1</span>Archivo</div><i className="step-line"/><div className={`step ${preview ? 'active' : ''}`}><span>2</span>Preview</div><i className="step-line"/><div className={`step ${dirtyRows.size ? 'active' : ''}`}><span>3</span>Resolver</div><i className="step-line"/><div className="step"><span>4</span>Confirmar</div></div>
      {message ? <div className={`notice ${messageTone}`} role="status"><strong>{message}</strong></div> : null}
      <section className="panel form-panel import-panel">
        <div className="form-section">
          <h2>1. Destino y tratamiento</h2><p>Usa una obra existente o crea una nueva de forma transaccional junto con el preview.</p>
          <div className="target-switch" role="group" aria-label="Destino de importación">
            <button type="button" className={target === 'existing' ? 'active' : ''} onClick={() => { setTarget('existing'); clearPreview(); }}>Obra existente</button>
            <button type="button" className={target === 'new' ? 'active' : ''} onClick={() => { setTarget('new'); clearPreview(); }}>Nueva obra</button>
          </div>
          {target === 'existing' ? <div className="form-grid">
            <label className="field">Obra<select value={workId} onChange={(event) => setWorkId(event.target.value)}><option value="">Selecciona una obra</option>{works.map((work) => <option key={work.id} value={work.id}>{work.nombre}</option>)}</select></label>
            <label className="field">Tratamiento<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="inicial">Presupuesto inicial</option><option value="nueva_version">Nueva versión · reemplaza vigencia</option><option value="extra">Extra · suma partidas nuevas</option></select></label>
          </div> : <div className="form-grid">
            <label className="field">Nombre de la obra<input value={workName} maxLength={180} required onChange={(event) => setWorkName(event.target.value)} placeholder="Ej. Casa PSE" /></label>
            <label className="field">Ubicación opcional<input value={workLocation} maxLength={300} onChange={(event) => setWorkLocation(event.target.value)} placeholder="Ciudad, estado" /></label>
            <label className="field">Fecha de inicio opcional<input type="date" value={workStartDate} onChange={(event) => setWorkStartDate(event.target.value)} /></label>
            <label className="field">Fecha de término opcional<input type="date" value={workEndDate} min={workStartDate || undefined} onChange={(event) => setWorkEndDate(event.target.value)} /></label>
            <div className="notice field full"><strong>Presupuesto inicial.</strong> La obra solo se creará si el archivo produce un preview válido.</div>
          </div>}
        </div>
        <div className="form-section">
          <h2>2. Archivo NEODATA</h2><p>Se procesan todas las hojas. Máximo 10 MB; macros y enlaces externos se rechazan.</p>
          <label className="dropzone"><span><span className="dropzone-icon"><UploadIcon size={24} /></span><strong>{file?.name || 'Suelta aquí tu archivo .xlsx'}</strong><p>{file ? 'Listo para generar el preview detallado' : 'El archivo original permanece fuera del repositorio.'}</p><input type="file" accept=".xlsx,.XLSX" onChange={(event) => { setFile(event.target.files?.[0]); clearPreview(); }} /></span></label>
          {file ? <div className="notice"><strong>Sin escritura presupuestal todavía.</strong> La confirmación se habilita solo después de revisar el preview.</div> : null}
        </div>
        {preview ? <div className="form-section preview-section">
          <h2>Preview {preview.read_only ? 'confirmado · solo lectura' : 'editable'}</h2>
          <div className="metrics preview-metrics">
            <article className="metric-card"><span className="metric-label">Áreas</span><strong className="metric-value">{preview.preview.area_count}</strong></article>
            <article className="metric-card"><span className="metric-label">Renglones</span><strong className="metric-value">{preview.preview.item_count}</strong><span className="metric-foot">{preview.preview.consolidated_item_count} partidas al confirmar</span></article>
            <article className="metric-card"><span className="metric-label">Subtotales</span><strong className="metric-value">{preview.preview.section_total_count}</strong><span className="metric-foot">{preview.preview.rollup_total_count} totales jerárquicos</span></article>
            <article className="metric-card"><span className="metric-label">Total sin IVA</span><strong className="metric-value">{money(preview.preview.calculated_total_without_vat)}</strong></article>
          </div>
          <p>Alertas: {preview.preview.warnings.length}. Filas sin clasificar: {preview.preview.unclassified.length}. Descuadres: {preview.preview.section_mismatches.length}.</p>
          <div className="preview-toolbar"><label className="field">Buscar partidas<input type="search" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }} placeholder="Código, descripción, área o clase" /></label><span>{filteredItems.length} de {items.length} partidas</span></div>
          <div className="preview-table-wrap"><table className="preview-table"><thead><tr><th>Fila</th><th>Área</th><th>Clase</th><th>Categoría</th><th>Código</th><th>Descripción</th><th>Unidad</th><th>Cantidad</th><th>P. unitario</th><th>Importe</th></tr></thead><tbody>{visibleItems.map((item, index) => <tr key={`${item.sheet}:${item.row}`}><td>{item.row}</td>{editableFields.map((field) => <td key={field}><input aria-label={`${field} fila ${item.row}`} value={item[field] || ''} readOnly={preview.read_only} onChange={(event) => editItem(index, field, event.target.value)} /></td>)}<td className="number">{item.quantity}</td><td className="number">{money(item.unit_price)}</td><td className="number">{money(item.amount)}</td></tr>)}</tbody></table></div>
          <div className="pagination"><button className="btn secondary" type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Anterior</button><span>Página {page} de {pageCount}</span><button className="btn secondary" type="button" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>Siguiente</button></div>
        </div> : null}
        <div className="form-section"><div className="header-actions"><button className="btn secondary" type="button" onClick={() => { setFile(undefined); clearPreview(); }}>Limpiar</button>{preview ? <><button className="btn secondary" type="button" disabled={busy || preview.read_only || dirtyRows.size === 0} onClick={saveCorrections}>{dirtyRows.size ? `Guardar ${dirtyRows.size} corrección(es)` : 'Correcciones guardadas'}</button><button className="btn" type="button" disabled={busy || preview.read_only || preview.preview.unclassified.length > 0 || preview.preview.section_mismatches.length > 0} onClick={confirmPreview}>Confirmar presupuesto</button></> : <button className="btn" type="button" disabled={!canGenerate || busy} onClick={generatePreview}>{busy ? 'Procesando…' : 'Generar preview'}</button>}</div></div>
      </section>
    </AppShell>
  );
}
