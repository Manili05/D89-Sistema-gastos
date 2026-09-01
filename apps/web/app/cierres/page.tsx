'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { LockIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string };

export default function WeeklyClosePage() {
  const [closed, setClosed] = useState(false);
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
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

  async function closeWeek() {
    if (!workId) return;
    setBusy(true);
    try {
      const result = await apiJson<{ expense_count: number }>('/weekly-closes', {
        method: 'POST',
        body: JSON.stringify({ work_id: workId, iso_year: 2026, iso_week: 35 }),
      });
      setClosed(true);
      setMessage(`Cierre confirmado con ${result.expense_count} movimientos.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible cerrar la semana.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppShell active="/cierres">
      <PageHeader eyebrow="Control y auditoría" title="Cierre semanal" description="Revisa los movimientos incluidos en el lote. La reapertura siempre exige motivo y deja evidencia." actions={<button className="btn" type="button" onClick={closeWeek} disabled={closed || busy || !workId}><LockIcon />{closed ? 'Semana cerrada' : busy ? 'Cerrando…' : 'Cerrar semana 35'}</button>} />
      <label className="field">Obra<select value={workId} onChange={(event) => setWorkId(event.target.value)}><option value="">Seleccionar obra</option>{works.map((work) => <option value={work.id} key={work.id}>{work.nombre}</option>)}</select></label>
      <section className="metrics"><article className="metric-card" style={{ '--accent': '#17233c' } as React.CSSProperties}><span className="metric-label">Movimientos</span><strong className="metric-value">12</strong><span className="metric-foot">Del 24 al 30 de agosto</span></article><article className="metric-card" style={{ '--accent': '#2e785b' } as React.CSSProperties}><span className="metric-label">Validados</span><strong className="metric-value">8</strong><span className="metric-foot">$64,280.00</span></article><article className="metric-card" style={{ '--accent': '#b78027' } as React.CSSProperties}><span className="metric-label">Pendientes</span><strong className="metric-value">4</strong><span className="metric-foot">$22,140.00</span></article><article className="metric-card" style={{ '--accent': '#c66a3d' } as React.CSSProperties}><span className="metric-label">Total del lote</span><strong className="metric-value">$86,420.00</strong><span className="metric-foot">Snapshot al cierre</span></article></section>
      {message ? <div className="notice" role="status"><strong>{message}</strong>{closed ? ' El lote y los importes quedaron inmovilizados en la bitácora.' : ''}</div> : null}
      <section className="panel"><div className="panel-header"><div><h2>Infra Toluca · semana 35</h2><p>Gastos incluidos en el cierre</p></div><StatusPill tone={closed ? 'green' : 'amber'}>{closed ? 'Cerrado' : 'En revisión'}</StatusPill></div><div className="close-list">{[
        ['28 ago', 'Cemento y adhesivo', '$18,450.00', 'Validado'], ['27 ago', 'Instalación eléctrica', '$24,800.00', 'Validado'], ['26 ago', 'Carpintería comedor', '$21,030.00', 'Pendiente'], ['25 ago', 'Flete de materiales', '$4,680.00', 'Pendiente'],
      ].map(([date, concept, amount, state]) => <div className="close-row" key={concept}><div><strong>{concept}</strong><p>{date} · Infra Toluca</p></div><span>{amount}</span><span>Web</span><StatusPill tone={state === 'Validado' ? 'green' : 'amber'}>{state}</StatusPill></div>)}</div></section>
    </AppShell>
  );
}
