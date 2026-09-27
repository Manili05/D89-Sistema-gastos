'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PageHeader } from '@/components/page-header';
import { type WorkCatalog, WorkExpenseForm } from '@/components/work-expense-form';
import { apiJson } from '@/lib/auth';

type Work = { id: string; nombre: string };

export default function ExpensesPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [catalog, setCatalog] = useState<{ workId: string; value: WorkCatalog } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // Bumped after each save so the shared form remounts with clean state.
  const [formVersion, setFormVersion] = useState(0);
  const currentCatalog = catalog?.workId === workId ? catalog.value : null;

  useEffect(() => {
    let cancelled = false;
    apiJson<Work[]>('/works').then((result) => {
      if (cancelled) return;
      setWorks(result);
      setWorkId(result[0]?.id || '');
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!workId) return;
    let cancelled = false;
    apiJson<WorkCatalog>(`/works/${workId}/catalog`)
      .then((value) => { if (!cancelled) { setCatalog({ workId, value }); setError(''); } })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [workId]);

  return <AppShell active="/gastos">
    <PageHeader eyebrow="Captura semanal" title="Nuevo gasto"
      description="Clasifica cada movimiento de lo general a lo específico y conserva su comprobante." />
    {message && <div className="notice" role="status"><strong>{message}</strong></div>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <section className="panel form-section" aria-label="Seleccionar obra">
      <label className="field">Obra<select aria-label="Obra" value={workId} onChange={(event) => { setWorkId(event.target.value); setMessage(''); }}><option value="">Seleccionar obra</option>{works.map((work) => <option key={work.id} value={work.id}>{work.nombre}</option>)}</select></label>
    </section>
    {!workId && <p className="empty-state">Selecciona una obra para registrar el gasto.</p>}
    {workId && !currentCatalog && !error && <p role="status">Cargando catálogo de la obra…</p>}
    {currentCatalog && <WorkExpenseForm key={`${workId}-${formVersion}`} workId={workId} catalog={currentCatalog}
      onSaved={(text) => { setMessage(`${text} Quedó listo para validación semanal.`); setFormVersion((value) => value + 1); }} />}
  </AppShell>;
}
