'use client';

import Link from 'next/link';
import type { Route } from 'next';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ToggleGroup from '@radix-ui/react-toggle-group';
import { AppShell } from '@/components/app-shell';
import { PlusIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { type CategorySpend, type ItemSpend, type ProviderSpend, ProviderSpendChart, SpendBreakdown } from '@/components/spend-breakdown';
import { StatusPill } from '@/components/status-pill';
import { CASHFLOW_COLORS, CashflowChart } from '@/components/cashflow-chart';
import { ExpenseDetailView } from '@/components/expense-detail-view';
import { IncomePanel } from '@/components/income-panel';
import { IncomeReconcilePanel } from '@/components/income-reconcile-panel';
import { WeeklyClosePanel } from '@/components/weekly-close-panel';
import { EditableExpense, WorkCatalog, WorkExpenseForm } from '@/components/work-expense-form';
import { apiFetch, apiJson, getSupabaseBrowserClient } from '@/lib/auth';
import { centsFromDecimal, displayCents } from '@/lib/money';

type Tab = 'resumen' | 'gastos' | 'ingresos' | 'validacion' | 'presupuesto' | 'cierres' | 'configuracion';
type Amount = string | number;
type Work = {
  id: string; nombre: string; ubicacion: string | null; fecha_inicio: string | null;
  fecha_fin: string | null; estado: string; areas: number; partidas: number;
  permissions: { can_manage: boolean; can_validate: boolean };
};
type AreaMetric = {
  id: string; parent_id: string | null; nombre: string; ruta: string[]; nivel: number;
  seleccionable: boolean; budget: Amount; validated: Amount; committed: Amount;
  available: Amount; execution_percent: Amount;
};
type Overview = {
  totals: { budget: Amount; validated: Amount; committed: Amount; available: Amount;
    projected_available: Amount; execution_percent: Amount; pending: Amount;
    pending_count: number; rejected_count: number; missing_receipts: number };
  period: { validated: Amount; pending: Amount };
  areas: AreaMetric[];
  weekly: { week: string; validated: Amount; pending: Amount }[];
  suppliers: { name: string; amount: Amount }[];
  categories: { name: string; amount: Amount }[];
  /** Cumulative to the period end, like `totals.validated`. */
  incomes: { total: Amount; reconciled: Amount; pending: Amount; count: number };
  /** Cumulative spend by the 23-item catalog and by category (Cambio 8). */
  by_item: ItemSpend[];
  by_category: CategorySpend[];
  by_provider: ProviderSpend[];
};
type ValidationMode = 'gastos' | 'ingresos';
type Expense = EditableExpense & {
  estado: 'pendiente' | 'validado' | 'rechazado'; area: string | null; area_ruta: string[] | null;
  partida: string; subpartida: string; categoria: string; autor: string;
  motivo_revision: string | null; creado_por: string; expense_locked: boolean;
  can_edit: boolean; can_cancel: boolean; can_resubmit: boolean;
};
type ExpensesPage = { items: Expense[]; total: number; page: number; page_size: number };
type ExpenseStateFilter = 'todos' | Expense['estado'];

const expenseStates: { value: ExpenseStateFilter; label: string }[] = [
  { value: 'todos', label: 'Todos' },
  { value: 'pendiente', label: 'Pendientes' },
  { value: 'validado', label: 'Validados' },
  { value: 'rechazado', label: 'Rechazados' },
];

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const currency = (value?: Amount) => value === undefined ? '—' : money.format(Number(value));

const tabs: { id: Tab; label: string }[] = [
  { id: 'resumen', label: 'Resumen' }, { id: 'gastos', label: 'Gastos' }, { id: 'ingresos', label: 'Ingresos' },
  { id: 'validacion', label: 'Validación' }, { id: 'presupuesto', label: 'Presupuesto' },
  { id: 'cierres', label: 'Cierres' }, { id: 'configuracion', label: 'Configuración' },
];

function tabHref(workId: string, tab: Tab): Route {
  return (tab === 'resumen' ? `/obras/${workId}` : `/obras/${workId}/${tab}`) as Route;
}

function statusTone(state: string): 'green' | 'amber' | 'red' | 'navy' {
  if (state === 'validado' || state === 'cerrado' || state === 'activa') return 'green';
  if (state === 'rechazado') return 'red';
  if (state === 'reabierto') return 'navy';
  return 'amber';
}

function rangeFor(period: string, customFrom: string, customTo: string) {
  const now = new Date();
  const local = (value: Date) => {
    const offset = value.getTimezoneOffset() * 60000;
    return new Date(value.getTime() - offset).toISOString().slice(0, 10);
  };
  if (period === 'acumulado') return { from: '', to: local(now) };
  if (period === 'personalizado') return { from: customFrom, to: customTo };
  const start = new Date(now);
  if (period === 'semana') start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  else start.setDate(1);
  return { from: local(start), to: local(now) };
}

function generateReceiptPath(workId: string, expenseId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${workId}/${expenseId}/${Date.now()}-${safeName}`;
}

export function WorkWorkspace({ workId, tab }: { workId: string; tab: Tab }) {
  const [work, setWork] = useState<Work>();
  const [catalog, setCatalog] = useState<WorkCatalog>();
  const [overview, setOverview] = useState<Overview>();
  const [expenses, setExpenses] = useState<ExpensesPage>();
  const [period, setPeriod] = useState('acumulado');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [stateFilter, setStateFilter] = useState<ExpenseStateFilter>('todos');
  const refreshVersion = useRef(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Expense>();
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [validationMode, setValidationMode] = useState<ValidationMode>('gastos');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const range = useMemo(() => rangeFor(period, customFrom, customTo), [period, customFrom, customTo]);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const params = new URLSearchParams();
      if (range.from) params.set('from', range.from);
      if (range.to) params.set('to', range.to);
      const expenseParams = new URLSearchParams(params);
      if (search.trim()) expenseParams.set('q', search.trim());
      expenseParams.set('page_size', '50');
      const [workData, catalogData, overviewData, expenseData] = await Promise.all([
        apiJson<Work>(`/works/${workId}`),
        apiJson<WorkCatalog>(`/works/${workId}/catalog`),
        apiJson<Overview>(`/works/${workId}/overview?${params}`),
        apiJson<ExpensesPage>(`/works/${workId}/expenses?${expenseParams}`),
      ]);
      // State filters run locally, so include matches beyond the first API page.
      if (tab === 'gastos') {
        const items = [...expenseData.items];
        const pages = Math.ceil(expenseData.total / expenseData.page_size);
        for (let page = 2; page <= pages; page += 1) {
          if (version !== refreshVersion.current) return;
          expenseParams.set('page', String(page));
          const next = await apiJson<ExpensesPage>(`/works/${workId}/expenses?${expenseParams}`);
          items.push(...next.items);
        }
        expenseData.items = items;
      }
      if (version !== refreshVersion.current) return;
      setError('');
      setWork(workData); setCatalog(catalogData); setOverview(overviewData);
      setExpenses(expenseData);
    } catch (reason) {
      if (version !== refreshVersion.current) return;
      setError(reason instanceof Error ? reason.message : 'No fue posible cargar la obra.');
    }
  }, [range.from, range.to, search, tab, workId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => { window.clearTimeout(timer); refreshVersion.current += 1; };
  }, [refresh]);

  async function review(expenseId: string, action: string) {
    const needsReason = action === 'reject' || action === 'return_to_review';
    const reason = needsReason ? window.prompt('Escribe el motivo (mínimo 5 caracteres):') : null;
    if (needsReason && (!reason || reason.trim().length < 5)) return;
    setBusy(true); setError('');
    try {
      await apiJson(`/expenses/${expenseId}/review`, {
        method: 'POST', body: JSON.stringify({ action, reason }),
      });
      setMessage(action === 'validate' ? 'Gasto validado.' : action === 'reject' ? 'Gasto rechazado.' : 'Estado actualizado.');
      setSelected([]); await refresh();
    } catch (reasonError) { setError(reasonError instanceof Error ? reasonError.message : 'No fue posible revisar.'); }
    finally { setBusy(false); }
  }

  async function batchValidate() {
    if (!selected.length) return;
    setBusy(true); setError('');
    try {
      await apiJson('/expenses/review-batch', {
        method: 'POST', body: JSON.stringify({ work_id: workId, expense_ids: selected }),
      });
      setMessage(`${selected.length} gastos validados en un solo lote.`); setSelected([]); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No fue posible validar el lote.'); }
    finally { setBusy(false); }
  }

  async function cancel(expenseId: string) {
    const reason = window.prompt('Motivo de cancelación (mínimo 5 caracteres):');
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    try {
      await apiJson(`/expenses/${expenseId}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) });
      setMessage('Gasto cancelado y conservado en auditoría.'); await refresh();
    } catch (reasonError) { setError(reasonError instanceof Error ? reasonError.message : 'No fue posible cancelar.'); }
    finally { setBusy(false); }
  }

  async function openReceipt(expense: Expense) {
    if (!expense.comprobante_path) return;
    const { data, error: storageError } = await getSupabaseBrowserClient().storage
      .from('comprobantes').createSignedUrl(expense.comprobante_path, 300);
    if (storageError) setError(storageError.message);
    else window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function attachReceipt(expense: Expense, file: File) {
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    if (!allowedTypes.has(file.type)) {
      setError('El comprobante debe ser JPG, PNG, WebP o PDF.');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('El comprobante no puede superar 10 MB.');
      return;
    }

    setBusy(true); setError(''); setMessage('');
    const path = generateReceiptPath(workId, expense.id, file.name);
    const storage = getSupabaseBrowserClient().storage.from('comprobantes');
    try {
      const { error: uploadError } = await storage.upload(path, file, {
        contentType: file.type, upsert: false,
      });
      if (uploadError) throw uploadError;
      try {
        await apiJson(`/expenses/${expense.id}/receipt`, {
          method: 'PATCH', body: JSON.stringify({ path }),
        });
      } catch (attachError) {
        await storage.remove([path]);
        throw attachError;
      }
      setMessage('Comprobante adjuntado. El gasto ya puede validarse.');
      await refresh();
    } catch (receiptError) {
      setError(receiptError instanceof Error
        ? `No fue posible adjuntar el comprobante: ${receiptError.message}`
        : 'No fue posible adjuntar el comprobante.');
    } finally {
      setBusy(false);
    }
  }

  async function saveWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true);
    try {
      await apiJson(`/works/${workId}`, { method: 'PATCH', body: JSON.stringify({ name: form.get('name'), location: form.get('location') || null, start_date: form.get('start_date') || null, end_date: form.get('end_date') || null, state: form.get('state') }) });
      setMessage('Datos de la obra actualizados.'); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'No fue posible actualizar la obra.'); }
    finally { setBusy(false); }
  }

  async function download(extension: 'xlsx' | 'pdf') {
    const response = await apiFetch(`/reports/works/${workId}.${extension}`);
    if (!response.ok) { setError('No fue posible generar el reporte.'); return; }
    const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `gastos-${work?.nombre || 'obra'}.${extension}`; anchor.click(); URL.revokeObjectURL(url);
  }

  const visibleTabs = tabs.filter((item) => item.id !== 'validacion' || work?.permissions.can_validate);
  const pending = expenses?.items.filter((expense) => expense.estado === 'pendiente') || [];
  const visibleExpenses = expenses?.items.filter((expense) => stateFilter === 'todos' || expense.estado === stateFilter) || [];
  const totals = overview?.totals;
  const incomes = overview?.incomes;
  // Net cash position: reconciled income minus validated expense (exact cents).
  const netFlow = incomes && totals
    ? (centsFromDecimal(String(incomes.reconciled)) ?? 0n) - (centsFromDecimal(String(totals.validated)) ?? 0n)
    : null;

  return <AppShell active="/" activeWork={work ? { name: work.nombre, detail: `${work.areas} áreas · ${work.partidas} partidas` } : undefined}>
    <PageHeader eyebrow="Gestión específica de obra" title={work?.nombre || 'Cargando obra…'} description={`${work?.ubicacion || 'Ubicación no registrada'} · ${work?.areas ?? '…'} áreas finales · ${work?.partidas ?? '…'} partidas`} actions={<><button className="btn secondary" onClick={() => void download('xlsx')}>Excel</button><button className="btn secondary" onClick={() => void download('pdf')}>PDF</button>{tab === 'gastos' && <button className="btn" onClick={() => { setEditing(undefined); setShowForm(true); }}><PlusIcon />Nuevo gasto</button>}</>} />
    <nav className="work-tabs" aria-label="Secciones de la obra">{visibleTabs.map((item) => <Link key={item.id} href={tabHref(workId, item.id)} className={tab === item.id ? 'active' : ''}>{item.label}</Link>)}</nav>
    {/* The period filter drives summary and expenses; income lists are shown in full. */}
    {tab !== 'ingresos' && !(tab === 'validacion' && validationMode === 'ingresos') && <div className="period-toolbar"><label>Periodo<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="semana">Semana actual</option><option value="mes">Mes actual</option><option value="acumulado">Acumulado</option><option value="personalizado">Personalizado</option></select></label>{period === 'personalizado' && <><label>Desde<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label><label>Hasta<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label></>}</div>}
    {error && <p className="notice error" role="alert">{error}</p>}{message && <p className="notice success" role="status">{message}</p>}

    {tab === 'resumen' && <>
      <section className="metrics work-metrics">
        <article className="metric-card" style={{ '--accent': '#17233c' } as CSSProperties}><span className="metric-label">Presupuesto vigente</span><strong className="metric-value">{currency(totals?.budget)}</strong><span className="metric-foot">Base NEODATA confirmada</span></article>
        <article className="metric-card" style={{ '--accent': CASHFLOW_COLORS.validated } as CSSProperties}><span className="metric-label">Gasto validado</span><strong className="metric-value">{currency(totals?.validated)}</strong><span className="metric-foot">{Number(totals?.execution_percent || 0).toFixed(1)}% ejercido</span></article>
        <article className="metric-card" style={{ '--accent': '#b78027' } as CSSProperties}><span className="metric-label">Comprometido</span><strong className="metric-value">{currency(totals?.committed)}</strong><span className="metric-foot">Incluye {totals?.pending_count || 0} pendientes</span></article>
        <article className="metric-card" style={{ '--accent': '#c66a3d' } as CSSProperties}><span className="metric-label">Disponible proyectado</span><strong className="metric-value">{currency(totals?.projected_available)}</strong><span className="metric-foot">Presupuesto menos compromiso</span></article>
      </section>
      <section className="metrics work-metrics income-metrics" aria-label="Indicadores de ingresos">
        <article className="metric-card" style={{ '--accent': '#17233c' } as CSSProperties}><span className="metric-label">Total cobrado</span><strong className="metric-value" data-testid="overview-income-total">{currency(incomes?.total)}</strong><span className="metric-foot">{incomes?.count ?? 0} ingreso{incomes?.count === 1 ? '' : 's'} registrado{incomes?.count === 1 ? '' : 's'}</span></article>
        <article className="metric-card" style={{ '--accent': CASHFLOW_COLORS.reconciled } as CSSProperties}><span className="metric-label">Ingreso conciliado</span><strong className="metric-value" data-testid="overview-income-reconciled">{currency(incomes?.reconciled)}</strong><span className="metric-foot">Confirmado contra comprobante</span></article>
        <article className="metric-card" style={{ '--accent': '#b78027' } as CSSProperties}><span className="metric-label">Pendiente de conciliar</span><strong className="metric-value" data-testid="overview-income-pending">{currency(incomes?.pending)}</strong><span className="metric-foot">Por confirmar en Validación</span></article>
        <article className="metric-card" style={{ '--accent': netFlow !== null && netFlow < 0n ? '#b6493f' : CASHFLOW_COLORS.validated } as CSSProperties}><span className="metric-label">Flujo neto</span><strong className="metric-value" data-testid="overview-net-flow">{netFlow === null ? '—' : `${netFlow < 0n ? '−' : '+'}${displayCents(netFlow < 0n ? -netFlow : netFlow)}`}</strong><span className="metric-foot">{netFlow === null ? 'Conciliado menos gasto validado' : netFlow < 0n ? 'Déficit: conciliado menos gasto validado' : 'Superávit: conciliado menos gasto validado'}</span></article>
      </section>
      <div className="content-grid"><section className="panel"><div className="panel-header"><div><h2>Flujo de efectivo</h2><p>Gasto validado contra ingreso conciliado, acumulado al cierre del periodo</p></div></div><CashflowChart validated={totals?.validated} reconciled={incomes?.reconciled} /></section><section className="panel"><div className="panel-header"><div><h2>Control operativo</h2><p>Elementos que requieren atención</p></div></div><div className="cash-grid"><div><span>Pendientes</span><strong>{totals?.pending_count || 0}</strong></div><div><span>Sin comprobante</span><strong>{totals?.missing_receipts || 0}</strong></div><div><span>Rechazados</span><strong>{totals?.rejected_count || 0}</strong></div></div></section></div>
      <section className="panel collapsible-panel">
        <h2 className="collapsible-heading"><button type="button" aria-expanded={breakdownOpen} aria-controls="spend-breakdown-body" onClick={() => setBreakdownOpen((open) => !open)}><span><span className="collapsible-title">Gasto por partida</span><small>Gasto acumulado por las 23 partidas y por categoría; el techo es el presupuesto NEODATA total</small></span><span className="collapsible-chevron" aria-hidden="true" /></button></h2>
        <div id="spend-breakdown-body" hidden={!breakdownOpen}>{breakdownOpen && <SpendBreakdown items={overview?.by_item || []} categories={overview?.by_category || []} />}</div>
      </section>
      <div className="work-analysis"><section className="panel"><div className="panel-header"><div><h2>Tendencia semanal</h2><p>Validado y pendiente en el periodo</p></div></div><div className="trend-list">{overview?.weekly.map((week) => <div key={week.week}><span>{week.week}</span><strong>{currency(week.validated)}</strong><small>{currency(week.pending)} pendiente</small></div>)}{overview?.weekly.length === 0 && <p className="empty-state">Aún no hay movimientos en el periodo.</p>}</div></section></div>
      <section className="panel provider-panel" aria-labelledby="provider-spend-title"><div className="panel-header"><div><h2 id="provider-spend-title">Gasto por proveedor</h2><p>Todos los proveedores con movimientos, de mayor a menor gasto validado, acumulado al cierre del periodo</p></div></div>{overview && <ProviderSpendChart providers={overview.by_provider} />}</section>
    </>}

    {tab === 'gastos' && <>{(showForm || editing) && catalog && <WorkExpenseForm key={editing?.id || 'new'} workId={workId} catalog={catalog} expense={editing} onCancel={() => { setShowForm(false); setEditing(undefined); }} onSaved={(text) => { setMessage(text); setShowForm(false); setEditing(undefined); void refresh(); }} />}<section className="panel"><div className="panel-header"><div><h2>Movimientos de la obra</h2><p role="status">{visibleExpenses.length} gastos encontrados</p></div><div className="expense-filters">
        <ToggleGroup.Root className="expense-state-filters" type="single" value={stateFilter} onValueChange={(value) => { if (expenseStates.some((state) => state.value === value)) setStateFilter(value as ExpenseStateFilter); }} aria-label="Estado del gasto">
          {expenseStates.map((state) => <ToggleGroup.Item key={state.value} value={state.value} className="expense-state-pill">{state.label}</ToggleGroup.Item>)}
        </ToggleGroup.Root>
        <input aria-label="Buscar gastos" placeholder="Concepto, folio o proveedor" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div></div><ExpenseTable items={visibleExpenses} busy={busy} onView={setViewingId} onReceipt={openReceipt} onEdit={(expense) => { setEditing(expense); setShowForm(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }} onCancel={cancel} onReview={review} canValidate={Boolean(work?.permissions.can_validate)} /></section></>}

    {tab === 'validacion' && <>
      <ToggleGroup.Root className="expense-state-filters validation-mode" type="single" value={validationMode} onValueChange={(value) => { if (value === 'gastos' || value === 'ingresos') setValidationMode(value); }} aria-label="Qué validar">
        <ToggleGroup.Item value="gastos" className="expense-state-pill">Validar gastos</ToggleGroup.Item>
        <ToggleGroup.Item value="ingresos" className="expense-state-pill">Conciliar ingresos</ToggleGroup.Item>
      </ToggleGroup.Root>
      {validationMode === 'gastos' ? <section className="panel"><div className="panel-header"><div><h2>Gastos pendientes de validar</h2><p>El comprobante es obligatorio para aprobar</p></div><button className="btn" disabled={!selected.length || busy} onClick={() => void batchValidate()}>Validar seleccionados ({selected.length})</button></div><div className="expense-table-wrap"><table className="expense-table"><thead><tr><th aria-label="Seleccionar" /><th>Fecha / concepto</th><th>Clasificación</th><th>Proveedor</th><th>Importe</th><th>Comprobante</th><th>Acciones</th></tr></thead><tbody>{pending.map((expense) => <tr key={expense.id}><td><input type="checkbox" aria-label={`Seleccionar ${expense.concepto}`} checked={selected.includes(expense.id)} disabled={!expense.comprobante_path || busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, expense.id] : current.filter((id) => id !== expense.id))} /></td><td><strong>{expense.concepto}</strong><small>{expense.fecha} · {expense.autor}</small></td><td>{classification(expense)}</td><td>{expense.proveedor}</td><td><strong>{currency(expense.importe)}</strong></td><td>{expense.comprobante_path ? <button className="text-action" disabled={busy} onClick={() => void openReceipt(expense)}>Ver archivo</button> : <><span className="missing-receipt">Faltante</span><label className={`text-action receipt-upload${busy ? ' disabled' : ''}`}>Adjuntar comprobante<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void attachReceipt(expense, file); }} /></label></>}</td><td><button className="text-action" disabled={!expense.comprobante_path || busy} title={!expense.comprobante_path ? 'Adjunta un comprobante para validar' : undefined} onClick={() => void review(expense.id, 'validate')}>Validar</button><button className="text-action danger" disabled={busy} onClick={() => void review(expense.id, 'reject')}>Rechazar</button></td></tr>)}</tbody></table>{pending.length === 0 && <p className="empty-state">No hay gastos pendientes.</p>}</div></section> : <IncomeReconcilePanel workId={workId} canManage={Boolean(work?.permissions.can_manage)} />}
    </>}

    {tab === 'presupuesto' && <section className="panel"><div className="panel-header"><div><h2>Árbol presupuestal NEODATA</h2><p>Los niveles padre acumulan automáticamente sus descendientes</p></div></div><div className="budget-tree">{overview?.areas.map((area) => <div className={`budget-node level-${Math.min(area.nivel, 5)}`} key={area.id}><div><strong>{area.nombre}</strong><small>{area.seleccionable ? 'Nivel con conceptos' : 'Capítulo acumulador'}</small></div><span>{currency(area.budget)}</span><span>{currency(area.validated)}</span><span>{currency(area.committed)}</span><StatusPill tone={Number(area.execution_percent) > 100 ? 'red' : Number(area.execution_percent) >= 85 ? 'amber' : 'green'}>{Number(area.execution_percent).toFixed(1)}%</StatusPill></div>)}</div></section>}

    {tab === 'ingresos' && <IncomePanel workId={workId} canManage={Boolean(work?.permissions.can_manage)} />}
    {tab === 'cierres' && <WeeklyClosePanel workId={workId} onChanged={() => void refresh()} />}

    {tab === 'configuracion' && work && <div className="work-config-grid"><section className="panel form-panel"><div className="panel-header"><div><h2>Datos generales</h2><p>Nombre, ubicación, calendario y estado</p></div></div>{work.permissions.can_manage ? <form onSubmit={saveWork}><div className="form-section"><div className="form-grid"><label className="field">Nombre<input name="name" defaultValue={work.nombre} required /></label><label className="field">Ubicación<input name="location" defaultValue={work.ubicacion || ''} /></label><label className="field">Fecha inicial<input name="start_date" type="date" defaultValue={work.fecha_inicio || ''} /></label><label className="field">Fecha final<input name="end_date" type="date" defaultValue={work.fecha_fin || ''} /></label><label className="field">Estado<select name="state" defaultValue={work.estado}><option value="activa">Activa</option><option value="pausada">Pausada</option><option value="cerrada">Cerrada</option></select></label></div></div><div className="form-section"><button className="btn" disabled={busy}>Guardar cambios</button></div></form> : <p className="empty-state">Sólo administración puede modificar estos datos.</p>}</section><section className="panel"><div className="panel-header"><div><h2>Proveedores de la obra</h2><p>{catalog?.suppliers.length || 0} disponibles para registrar gastos</p></div><Link className="btn secondary" href="/proveedores">Administrar</Link></div><div className="work-supplier-list">{catalog?.suppliers.map((supplier) => <Link key={supplier.id} href={`/proveedores/${supplier.id}` as Route}><span>{supplier.nombre}</span><span>Ver ficha →</span></Link>)}{!catalog?.suppliers.length ? <p className="empty-state">No hay proveedores asignados. Agrégalos desde el directorio.</p> : null}</div></section></div>}
    {viewingId && <ExpenseDetailView expenseId={viewingId} onClose={() => setViewingId(null)} />}
  </AppShell>;
}

/** Partida › Subpartida leads; the category and the optional NEODATA area follow. */
function classification(expense: Expense) {
  const area = expense.area_ruta?.join(' › ') || expense.area;
  return <>{expense.partida || 'Sin partida'}{expense.subpartida ? ` › ${expense.subpartida}` : ''}
    <small>{expense.categoria || 'Sin categoría'}{area ? ` · Área: ${area}` : ''}</small></>;
}

function ExpenseTable({ items, busy, onView, onReceipt, onEdit, onCancel, onReview, canValidate }: { items: Expense[]; busy: boolean; onView: (id: string) => void; onReceipt: (expense: Expense) => void; onEdit: (expense: Expense) => void; onCancel: (id: string) => void; onReview: (id: string, action: string) => void; canValidate: boolean }) {
  return <div className="expense-table-wrap"><table className="expense-table"><thead><tr><th>Fecha / concepto</th><th>Clasificación</th><th>Proveedor</th><th>Importe</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{items.map((expense) => <tr key={expense.id}><td><strong>{expense.concepto}</strong><small>{expense.folio} · {expense.fecha}{expense.folio_proveedor ? ` · Prov. ${expense.folio_proveedor}` : ''} · {expense.autor}</small></td><td>{classification(expense)}</td><td>{expense.proveedor}</td><td><strong>{currency(expense.importe)}</strong></td><td><StatusPill tone={statusTone(expense.estado)}>{expense.estado}</StatusPill>{expense.motivo_revision && <small>{expense.motivo_revision}</small>}</td><td><button className="text-action" onClick={() => onView(expense.id)} aria-label={`Ver detalle del gasto ${expense.folio}`}>Ver</button><button className="text-action" disabled={!expense.comprobante_path} onClick={() => onReceipt(expense)}>Comprobante</button>{expense.can_edit && <button className="text-action" disabled={busy} onClick={() => onEdit(expense)}>Editar</button>}{expense.can_cancel && <button className="text-action danger" disabled={busy} onClick={() => void onCancel(expense.id)}>Cancelar</button>}{expense.can_resubmit && <button className="text-action" disabled={busy} onClick={() => void onReview(expense.id, 'resubmit')}>Reenviar</button>}{expense.estado === 'validado' && canValidate && !expense.expense_locked && <button className="text-action" onClick={() => void onReview(expense.id, 'return_to_review')}>Devolver</button>}{expense.expense_locked && <small>Semana cerrada</small>}</td></tr>)}</tbody></table>{items.length === 0 && <p className="empty-state">No hay movimientos con estos filtros.</p>}</div>;
}
