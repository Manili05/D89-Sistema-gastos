'use client';

import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { PlusIcon } from '@/components/icons';
import { SubcontractDetail } from '@/components/subcontract-detail';
import { SubcontractForm } from '@/components/subcontract-form';
import { SubcontractTable } from '@/components/subcontract-table';
import type { WorkCatalog } from '@/components/work-expense-form';
import { apiJson } from '@/lib/auth';
import type { Subcontract } from '@/lib/estimation';
import { centsFromDecimal, displayCents } from '@/lib/money';

type FormState = { mode: 'create' } | { mode: 'edit'; item: Subcontract; locked: boolean } | null;

/** "Subcontratos" tab: piecework contracts of the work, their detail and estimations. */
export function SubcontractPanel({ workId, canManage }: { workId: string; canManage: boolean }) {
  const [items, setItems] = useState<Subcontract[] | null>(null);
  const [catalog, setCatalog] = useState<WorkCatalog>();
  const [form, setForm] = useState<FormState>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setItems(await apiJson<Subcontract[]>(`/works/${workId}/subcontracts`));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar los subcontratos.');
    }
  }, [workId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
      if (canManage) void apiJson<WorkCatalog>(`/works/${workId}/catalog`).then(setCatalog).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, workId, canManage]);

  useEffect(() => {
    if (form || viewingId) top.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [form, viewingId]);

  async function openEdit(item: Subcontract) {
    setMessage(''); setError('');
    try {
      // The detail tells whether estimations exist (they lock supplier, partida and %).
      const detail = await apiJson<Subcontract>(`/subcontracts/${item.id}`);
      setViewingId(null);
      setForm({ mode: 'edit', item: detail, locked: (detail.estimations || []).length > 0 });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar el subcontrato.');
    }
  }

  const total = (pick: (item: Subcontract) => string) => (items || [])
    .filter((item) => item.state !== 'cancelado')
    .reduce((sum, item) => sum + (centsFromDecimal(pick(item)) ?? 0n), 0n);

  return <>
    <div ref={top} className="income-form-anchor" />
    {message && <p className="notice success" role="status">{message}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {items && <section className="metrics income-panel-metrics" aria-label="Resumen de subcontratos">
      <article className="metric-card" style={{ '--accent': '#17233c' } as CSSProperties}><span className="metric-label">Contratado</span><strong className="metric-value" data-testid="subcontracts-contracted">{displayCents(total((item) => item.contracted_amount))}</strong><span className="metric-foot">{items.filter((item) => item.state !== 'cancelado').length} subcontratos vigentes o finiquitados</span></article>
      <article className="metric-card" style={{ '--accent': '#1f8055' } as CSSProperties}><span className="metric-label">Pagado (neto)</span><strong className="metric-value" data-testid="subcontracts-paid">{displayCents(total((item) => item.paid_net))}</strong><span className="metric-foot">Suma al gasto validado de la obra</span></article>
      <article className="metric-card" style={{ '--accent': '#b78027' } as CSSProperties}><span className="metric-label">Retenido</span><strong className="metric-value" data-testid="subcontracts-retained">{displayCents(total((item) => item.retained))}</strong><span className="metric-foot">Fondo de garantía acumulado</span></article>
    </section>}
    {form && catalog && <SubcontractForm key={form.mode === 'edit' ? form.item.id : 'new'} workId={workId} catalog={catalog}
      initial={form.mode === 'edit' ? form.item : undefined} locked={form.mode === 'edit' && form.locked}
      onCancel={() => setForm(null)}
      onSaved={(saved, text) => { setForm(null); setMessage(text); setViewingId(saved.id); void load(); }} />}
    {viewingId && !form && <SubcontractDetail key={viewingId} subcontractId={viewingId} canManage={canManage}
      onChanged={() => void load()} onClose={() => setViewingId(null)}
      onEdit={canManage ? (item) => void openEdit(item) : undefined} />}
    <section className="panel" aria-label="Subcontratos de la obra">
      <div className="panel-header">
        <div><h2>Subcontratos (destajos)</h2><p>Mano de obra y servicios · el material lo pone la constructora</p></div>
        {canManage && !form && <button type="button" className="btn" disabled={!catalog} onClick={() => { setMessage(''); setViewingId(null); setForm({ mode: 'create' }); }}><PlusIcon />Nuevo subcontrato</button>}
      </div>
      {items ? <SubcontractTable items={items}
        onView={(item) => { setMessage(''); setForm(null); setViewingId(item.id); }}
        onEdit={canManage ? (item) => void openEdit(item) : undefined}
        onCreate={canManage && !form ? () => { setMessage(''); setForm({ mode: 'create' }); } : undefined} />
        : !error && <p className="empty-state" role="status">Cargando subcontratos…</p>}
    </section>
  </>;
}
