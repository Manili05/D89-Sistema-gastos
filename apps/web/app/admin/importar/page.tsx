'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { UploadIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { apiFetch, apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string; presupuesto: string };
type PreviewResponse = {
  id: string;
  estado: string;
  preview: {
    area_count: number;
    item_count: number;
    section_total_count: number;
    calculated_total_without_vat: string;
    warnings: string[];
    unclassified: unknown[];
    section_mismatches: unknown[];
  };
};

export default function ImportPage() {
  const [file, setFile] = useState<File>();
  const [mode, setMode] = useState('nueva_version');
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [preview, setPreview] = useState<PreviewResponse>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<Work[]>('/works')
      .then((result) => {
        setWorks(result);
        setWorkId(result[0]?.id || '');
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  async function generatePreview() {
    if (!file || !workId) return;
    setBusy(true);
    setMessage('');
    const body = new FormData();
    body.set('work_id', workId);
    body.set('import_type', mode);
    body.set('file', file);
    const response = await apiFetch('/neodata/preview', { method: 'POST', body });
    const payload = (await response.json()) as PreviewResponse & { detail?: string };
    setBusy(false);
    if (!response.ok) {
      setMessage(payload.detail || `No fue posible generar el preview (${response.status}).`);
      return;
    }
    setPreview(payload);
  }

  async function confirmPreview() {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await apiJson<{ version_resultante: number; item_count: number }>(
        `/neodata/imports/${preview.id}/confirm`,
        { method: 'POST', body: JSON.stringify({ confirmation: true }) },
      );
      setMessage(
        `Presupuesto v${result.version_resultante} confirmado con ${result.item_count} partidas.`,
      );
      setPreview(undefined);
      setFile(undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible confirmar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell active="/admin/importar">
      <PageHeader eyebrow="Portal administrador" title="Importar presupuesto" description="Carga el Excel de NEODATA, revisa la interpretación y confirma solo cuando todo esté correcto." />
      <div className="steps" aria-label="Progreso de importación"><div className="step active"><span>1</span>Archivo</div><i className="step-line"/><div className={`step ${preview ? 'active' : ''}`}><span>2</span>Preview</div><i className="step-line"/><div className="step"><span>3</span>Resolver</div><i className="step-line"/><div className="step"><span>4</span>Confirmar</div></div>
      {message ? <div className="notice" role="status"><strong>{message}</strong></div> : null}
      <section className="panel form-panel">
        <div className="form-section"><h2>1. Destino y tratamiento</h2><p>La detección de duplicado ocurre antes de escribir cualquier partida.</p><div className="form-grid"><label className="field">Obra<select value={workId} onChange={(event) => setWorkId(event.target.value)}><option value="">Selecciona una obra</option>{works.map((work) => <option key={work.id} value={work.id}>{work.nombre}</option>)}</select></label><label className="field">Tratamiento<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="inicial">Presupuesto inicial</option><option value="nueva_version">Nueva versión · reemplaza vigencia</option><option value="extra">Extra · suma partidas nuevas</option></select></label></div></div>
        <div className="form-section"><h2>2. Archivo NEODATA</h2><p>Se procesan todas las hojas. Máximo 10 MB; macros y enlaces externos se rechazan.</p><label className="dropzone"><span><span className="dropzone-icon"><UploadIcon size={24}/></span><strong>{file?.name || 'Suelta aquí tu archivo .xlsx'}</strong><p>{file ? 'Listo para generar preview editable' : 'El archivo original permanece fuera del repositorio.'}</p><input type="file" accept=".xlsx" onChange={(event) => { setFile(event.target.files?.[0]); setPreview(undefined); }}/></span></label>{file ? <div className="notice"><strong>Sin escritura todavía.</strong> La confirmación se habilita solo después de revisar el preview.</div> : null}</div>
        {preview ? <div className="form-section"><h2>Preview persistido</h2><div className="metrics"><article className="metric-card"><span className="metric-label">Áreas</span><strong className="metric-value">{preview.preview.area_count}</strong></article><article className="metric-card"><span className="metric-label">Partidas</span><strong className="metric-value">{preview.preview.item_count}</strong></article><article className="metric-card"><span className="metric-label">Totales</span><strong className="metric-value">{preview.preview.section_total_count}</strong></article></div><p>Alertas: {preview.preview.warnings.length}. Filas sin clasificar: {preview.preview.unclassified.length}. Descuadres: {preview.preview.section_mismatches.length}.</p></div> : null}
        <div className="form-section"><div className="header-actions"><button className="btn secondary" type="button" onClick={() => { setFile(undefined); setPreview(undefined); }}>Limpiar</button>{preview ? <button className="btn" type="button" disabled={busy || preview.preview.unclassified.length > 0 || preview.preview.section_mismatches.length > 0} onClick={confirmPreview}>Confirmar presupuesto</button> : <button className="btn" type="button" disabled={!file || !workId || busy} onClick={generatePreview}>{busy ? 'Procesando…' : 'Generar preview'}</button>}</div></div>
      </section>
    </AppShell>
  );
}
