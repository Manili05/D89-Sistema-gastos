'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { WeeklyClosePanel } from '@/components/weekly-close-panel';
import { apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string };

export default function WeeklyClosePage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    apiJson<Work[]>('/works').then((result) => {
      if (cancelled) return;
      setWorks(result);
      setWorkId(result[0]?.id || '');
    }).catch((error: Error) => { if (!cancelled) setMessage(error.message); });
    return () => { cancelled = true; };
  }, []);

  return <AppShell active="/cierres">
    <PageHeader eyebrow="Control y auditoría" title="Cierre semanal"
      description="Consulta la semana, revisa sus gastos y conserva evidencia de cada cierre." />
    {message && <p className="notice error" role="alert">{message}</p>}
    <WeeklyClosePanel workId={workId} workName={works.find((work) => work.id === workId)?.nombre}
      workField={(busy) => <label className="field">Obra<select value={workId} disabled={busy} onChange={(event) => setWorkId(event.target.value)}><option value="">Seleccionar obra</option>{works.map((work) => <option value={work.id} key={work.id}>{work.nombre}</option>)}</select></label>} />
  </AppShell>;
}
