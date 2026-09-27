'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { LockIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string };
type Amount = string | number;
type StateTotal = { count: number; amount: Amount };
type Preview = {
  work_id: string; iso_year: number; iso_week: number; date_from: string; date_to: string;
  summary: { count: number; amount: Amount; pendiente: StateTotal; validado: StateTotal; rechazado: StateTotal };
  expenses: { id: string; fecha: string; concepto: string; importe: Amount; estado: string; origen: string }[];
  close: { id: string; estado: string; revision: number } | null;
  revisions: { revision: number; expense_count: number; amount: Amount }[];
  history: { accion: string; creado_en: string; autor: string; detalle_json: { revision?: number; motivo?: string } }[];
  permissions: { can_manage: boolean };
};
const money = (value: Amount) => new Intl.NumberFormat('es-MX', {
  style: 'currency', currency: 'MXN',
}).format(Number(value));

function isoWeek(date: Date): string {
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function currentWeek(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return isoWeek(new Date(Date.UTC(part('year'), part('month') - 1, part('day'))));
}

function shiftWeek(value: string, delta: number): string {
  const [year, week] = value.split('-W').map(Number);
  if (!year || !week) return currentWeek();
  const date = new Date(Date.UTC(year, 0, 4));
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() || 7) + 1 + (week - 1 + delta) * 7);
  return isoWeek(date);
}

export default function WeeklyClosePage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [week, setWeek] = useState(currentWeek);
  const [loaded, setLoaded] = useState<{ key: string; value: Preview } | null>(null);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const [message, setMessage] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const submitting = useRef(false);
  const [year, weekNumber] = week.split('-W').map(Number);
  const validWeek = /^\d{4}-W\d{2}$/.test(week) && Boolean(year && weekNumber);
  const key = `${workId}/${week}/${refresh}`;
  const preview = loaded?.key === key ? loaded.value : null;
  const error = loadError?.key === key ? loadError.message : '';
  const closed = preview?.close?.estado === 'cerrado';

  useEffect(() => {
    let cancelled = false;
    apiJson<Work[]>('/works').then((result) => {
      if (cancelled) return;
      setWorks(result);
      setWorkId(result[0]?.id || '');
    }).catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!workId || !validWeek) return;
    let cancelled = false;
    apiJson<Preview>(`/works/${workId}/weekly-closes/preview?iso_year=${year}&iso_week=${weekNumber}`)
      .then((value) => { if (!cancelled) setLoaded({ key, value }); })
      .catch((error: Error) => { if (!cancelled) setLoadError({ key, message: error.message }); });
    return () => { cancelled = true; };
  }, [key, validWeek, workId, year, weekNumber]);

  function selectWeek(value: string) {
    setWeek(value);
    setMessage('');
    setReason('');
  }

  async function mutate(action: 'close' | 'reopen') {
    if (!preview || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setMessage('');
    try {
      if (action === 'close') {
        const result = await apiJson<{ expense_count: number }>('/weekly-closes', {
          method: 'POST', body: JSON.stringify({ work_id: workId, iso_year: year, iso_week: weekNumber }),
        });
        setMessage(`Cierre confirmado con ${result.expense_count} movimientos.`);
      } else {
        await apiJson(`/weekly-closes/${preview.close?.id}/reopen`, {
          method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
        });
        setMessage('Semana reabierta. Las correcciones requerirán un nuevo cierre.');
        setReason('');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible actualizar la semana.');
    } finally {
      setRefresh((value) => value + 1);
      submitting.current = false;
      setBusy(false);
    }
  }

  return <AppShell active="/cierres">
    <PageHeader eyebrow="Control y auditoría" title="Cierre semanal"
      description="Consulta la semana, revisa sus gastos y conserva evidencia de cada cierre."
      actions={preview?.permissions.can_manage && !closed
        ? <button className="btn" onClick={() => void mutate('close')} disabled={busy || preview.summary.pendiente.count > 0}><LockIcon />{busy ? 'Guardando…' : `Cerrar semana ${weekNumber}`}</button>
        : undefined} />
    <section className="panel form-section" aria-label="Seleccionar periodo">
      <div className="form-grid three">
        <label className="field">Obra<select value={workId} disabled={busy} onChange={(event) => { setWorkId(event.target.value); setMessage(''); setReason(''); }}><option value="">Seleccionar obra</option>{works.map((work) => <option value={work.id} key={work.id}>{work.nombre}</option>)}</select></label>
        <label className="field">Semana ISO<input type="week" min="2000-W01" max="2200-W52" value={week} disabled={busy} onChange={(event) => selectWeek(event.target.value)} /></label>
        <div className="header-actions"><button className="btn secondary" disabled={busy || !validWeek || (year === 2000 && weekNumber === 1)} onClick={() => selectWeek(shiftWeek(week, -1))}>Anterior</button><button className="btn secondary" disabled={busy} onClick={() => selectWeek(currentWeek())}>Hoy</button><button className="btn secondary" disabled={busy || !validWeek || (year === 2200 && weekNumber === 52)} onClick={() => selectWeek(shiftWeek(week, 1))}>Siguiente</button></div>
      </div>
    </section>
    {message && <p className="notice" role="status">{message}</p>}
    {error && <div className="notice error" role="alert">{error} <button className="text-action" onClick={() => setRefresh((value) => value + 1)}>Reintentar consulta</button></div>}
    {!workId && <p className="empty-state">Selecciona una obra para consultar sus cierres.</p>}
    {workId && !validWeek && <p className="notice">Selecciona una semana válida.</p>}
    {workId && validWeek && !preview && !error && <p role="status">Consultando semana…</p>}
    {preview && <>
      <section className="metrics" aria-label="Resumen de la semana">
        <article className="metric-card"><span className="metric-label">Movimientos</span><strong className="metric-value">{preview.summary.count}</strong><span className="metric-foot">{preview.date_from} al {preview.date_to}</span></article>
        <article className="metric-card"><span className="metric-label">Validados</span><strong className="metric-value">{money(preview.summary.validado.amount)}</strong><span className="metric-foot">{preview.summary.validado.count} gastos incluidos al cerrar</span></article>
        <article className="metric-card"><span className="metric-label">Pendientes</span><strong className="metric-value">{money(preview.summary.pendiente.amount)}</strong><span className="metric-foot">{preview.summary.pendiente.count} por revisar</span></article>
        <article className="metric-card"><span className="metric-label">Total no rechazado</span><strong className="metric-value">{money(preview.summary.amount)}</strong><span className="metric-foot">{preview.summary.rechazado.count} rechazados excluidos · {money(preview.summary.rechazado.amount)}</span></article>
      </section>
      {preview.summary.pendiente.count > 0 && <p className="notice">Valida o rechaza los gastos pendientes antes de cerrar esta semana.</p>}
      <section className="panel">
        <div className="panel-header"><div><h2>{works.find((work) => work.id === workId)?.nombre} · semana {preview.iso_week} / {preview.iso_year}</h2><p>{preview.close ? `Revisión ${preview.close.revision}` : 'Sin cierre registrado'}</p></div><StatusPill tone={closed ? 'green' : 'amber'}>{closed ? 'Cerrado' : preview.close ? 'Reabierto' : 'En revisión'}</StatusPill></div>
        <div className="close-list">{preview.expenses.map((expense) => <div className="close-row" key={expense.id}><div><strong>{expense.concepto}</strong><p>{expense.fecha}</p></div><span>{money(expense.importe)}</span><span>{expense.origen}</span><StatusPill tone={expense.estado === 'validado' ? 'green' : expense.estado === 'rechazado' ? 'red' : 'amber'}>{expense.estado}</StatusPill></div>)}</div>
        {!preview.expenses.length && <p className="empty-state">No hay gastos en la semana seleccionada.</p>}
        {closed && preview.permissions.can_manage && <div className="form-section"><label className="field">Motivo de reapertura<textarea value={reason} maxLength={500} disabled={busy} onChange={(event) => setReason(event.target.value)} placeholder="Explica la corrección necesaria (mínimo 10 caracteres)" /></label><button className="btn secondary" disabled={busy || reason.trim().length < 10} onClick={() => void mutate('reopen')}>Reabrir semana</button></div>}
      </section>
      <section className="panel"><div className="panel-header"><div><h2>Historial de cierres</h2><p>Los importes de revisiones anteriores se conservan.</p></div></div>
        {preview.revisions.map((revision) => <div className="close-row" key={revision.revision}><strong>Revisión {revision.revision}</strong><span>{revision.expense_count} gastos</span><span>{money(revision.amount)}</span></div>)}
        {preview.history.map((event, index) => <div className="close-row" key={`${event.creado_en}-${index}`}><strong>{event.accion === 'reabrir' ? 'Reapertura' : 'Cierre'} · revisión {event.detalle_json.revision || 1}</strong><span>{event.autor}</span><span>{new Date(event.creado_en).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}</span><span>{event.detalle_json.motivo || 'Lote registrado'}</span></div>)}
        {!preview.history.length && <p className="empty-state">Esta semana aún no tiene movimientos de cierre.</p>}
      </section>
    </>}
  </AppShell>;
}
