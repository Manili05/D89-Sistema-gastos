'use client';

import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';
import { AppShell } from '@/components/app-shell';
import { PlusIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { StatusPill } from '@/components/status-pill';
import { apiFetch, apiJson } from '@/lib/auth';

type Amount = string | number;
type Work = {
  id: string;
  nombre: string;
  ubicacion: string | null;
  presupuesto: Amount;
  gasto: Amount;
  pendiente: Amount;
  cobrado: Amount;
  por_cobrar: Amount;
  subcontratado: Amount;
  pagado_subcontratos: Amount;
};
type Dashboard = {
  works: Work[];
  totals: {
    budget: Amount;
    spent: Amount;
    available: Amount;
    pending: Amount;
    collected: Amount;
    receivable: Amount;
    subcontracted: Amount;
    subcontract_paid: Amount;
    cash_balance: Amount;
  };
};

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const currency = (value?: Amount) => value === undefined ? '—' : money.format(Number(value));

function workStatus(work: Work): { tone: 'green' | 'amber' | 'red'; label: string } {
  const budget = Number(work.presupuesto);
  const ratio = budget > 0 ? Number(work.gasto) / budget : 0;
  if (ratio > 1) return { tone: 'red', label: 'Excedida' };
  if (ratio >= 0.85) return { tone: 'amber', label: 'Atención' };
  return { tone: 'green', label: 'En control' };
}

export default function DashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    apiJson<Dashboard>('/dashboard').then(setDashboard).catch((reason: Error) => setError(reason.message));
  }, []);

  async function download(work: Work, extension: 'xlsx' | 'pdf') {
    setDownloading(`${work.id}-${extension}`);
    setError('');
    try {
      const response = await apiFetch(`/reports/works/${work.id}.${extension}`);
      if (!response.ok) throw new Error(`No fue posible exportar (${response.status})`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `gastos-${work.nombre.toLowerCase().replaceAll(' ', '-')}.${extension}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No fue posible exportar');
    } finally {
      setDownloading('');
    }
  }

  const totals = dashboard?.totals;
  const spentPercent = Number(totals?.budget) > 0
    ? (Number(totals?.spent) / Number(totals?.budget) * 100).toFixed(1)
    : '0.0';

  return (
    <AppShell active="/">
      <PageHeader eyebrow="Información en vivo" title="Panorama de obra" description="Presupuesto vigente, gasto real, flujo de caja y compromisos por obra." actions={<><Link className="btn secondary" href="/admin/importar">Importar NEODATA</Link><Link className="btn" href="/gastos"><PlusIcon />Nuevo gasto</Link></>} />
      {error && <p className="notice" role="alert">{error}</p>}
      <section className="metrics" aria-label="Indicadores principales" aria-busy={!dashboard}>
        <article className="metric-card" style={{ '--accent': '#17233c' } as CSSProperties}><span className="metric-label">Presupuesto activo <StatusPill tone="navy">{dashboard?.works.length ?? '…'} obras</StatusPill></span><strong className="metric-value">{currency(totals?.budget)}</strong><span className="metric-foot">Versión vigente confirmada</span></article>
        <article className="metric-card" style={{ '--accent': '#c66a3d' } as CSSProperties}><span className="metric-label">Gasto acumulado</span><strong className="metric-value">{currency(totals?.spent)}</strong><span className="metric-foot"><strong>{spentPercent}%</strong> del presupuesto</span></article>
        <article className="metric-card" style={{ '--accent': '#2e785b' } as CSSProperties}><span className="metric-label">Disponible</span><strong className="metric-value">{currency(totals?.available)}</strong><span className="metric-foot">Presupuesto menos gasto registrado</span></article>
        <article className="metric-card" style={{ '--accent': '#b78027' } as CSSProperties}><span className="metric-label">Pendiente de validar</span><strong className="metric-value">{currency(totals?.pending)}</strong><span className="metric-foot">Movimientos por revisar</span></article>
      </section>
      <div className="content-grid">
        <section className="panel">
          <div className="panel-header"><div><h2>Obras activas</h2><p>Comparativo y exportación autenticada</p></div></div>
          <div className="work-list">
            {dashboard?.works.map((work) => {
              const state = workStatus(work);
              return <article className="work-row" key={work.id}><div><h3>{work.nombre}</h3><p>{work.ubicacion || 'Ubicación no registrada'}</p></div><div><span className="amount-label">Presupuesto</span><span className="amount">{currency(work.presupuesto)}</span></div><div><span className="amount-label">Gasto real</span><span className="amount">{currency(work.gasto)}</span></div><div className="work-actions"><StatusPill tone={state.tone}>{state.label}</StatusPill><button className="text-action" type="button" disabled={Boolean(downloading)} onClick={() => download(work, 'xlsx')}>Excel</button><button className="text-action" type="button" disabled={Boolean(downloading)} onClick={() => download(work, 'pdf')}>PDF</button></div></article>;
            })}
            {dashboard && dashboard.works.length === 0 && <p className="empty-state">No hay obras asignadas a esta cuenta.</p>}
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Flujo de caja</h2><p>Ingresos reales contra egresos</p></div></div>
          <div className="cash-grid">
            <div><span className="amount-label">Cobrado</span><strong>{currency(totals?.collected)}</strong></div>
            <div><span className="amount-label">Por cobrar</span><strong>{currency(totals?.receivable)}</strong></div>
            <div><span className="amount-label">Saldo de caja</span><strong>{currency(totals?.cash_balance)}</strong></div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-header"><div><h2>Subcontratos</h2><p>Comprometido y pagado</p></div></div>
          <div className="cash-grid">
            <div><span className="amount-label">Contratado</span><strong>{currency(totals?.subcontracted)}</strong></div>
            <div><span className="amount-label">Pagado</span><strong>{currency(totals?.subcontract_paid)}</strong></div>
            <div><span className="amount-label">Saldo comprometido</span><strong>{currency(Number(totals?.subcontracted ?? 0) - Number(totals?.subcontract_paid ?? 0))}</strong></div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
