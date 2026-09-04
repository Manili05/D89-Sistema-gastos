'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from './app-shell';
import { PlusIcon } from './icons';
import { PageHeader } from './page-header';
import { StatusPill } from './status-pill';
import { SupplierFields } from './supplier-directory';
import { apiJson } from '@/lib/auth';

type Specialty = { id: string; nombre: string; activo: boolean; supplier_count: number };
type Assignment = {
  id: string; obra_id: string; obra: string; notas: string | null; activo: boolean;
};
type Evaluation = {
  id: string; obra_id: string | null; obra_nombre: string; gasto_id: string | null;
  gasto_concepto: string | null; trabajo: string; fecha_servicio: string;
  calidad: number; cumplimiento: number; costo_valor: number; comunicacion: number;
  seguridad_orden: number; calificacion: number | string; comentario: string | null;
  vigente: boolean; autor: string; motivo_anulacion: string | null;
};
type Expense = {
  id: string; obra_id: string; obra: string; fecha: string; concepto: string;
  folio: string | null; importe: number | string; estado: string;
};
type Supplier = {
  id: string; nombre: string; razon_social: string | null; rfc: string | null;
  contacto: string | null; telefono: string | null; whatsapp: string | null;
  email: string | null; direccion: string | null; cobertura: string | null;
  notas: string | null; activo: boolean;
  specialties: { id: string; nombre: string }[];
  evaluation_count: number; rating: number | string | null; quality: number | string | null;
  timeliness: number | string | null; value: number | string | null;
  communication: number | string | null; safety: number | string | null;
  work_count: number; expense_count: number | null; validated_spend: number | string | null;
  assignments: Assignment[]; evaluations: Evaluation[]; expenses: Expense[];
  permissions: { can_manage: boolean };
};
type Work = { id: string; nombre: string; estado?: string };

const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const criteria = [
  ['quality', 'Calidad'], ['timeliness', 'Cumplimiento'], ['value', 'Costo / valor'],
  ['communication', 'Comunicación'], ['safety', 'Seguridad y orden'],
] as const;

function displayScore(value: number | string | null): string {
  return value == null ? '—' : Number(value).toFixed(1);
}

function evaluationScore(evaluation: Evaluation | undefined, key: typeof criteria[number][0]) {
  if (!evaluation) return 5;
  const scores = {
    quality: evaluation.calidad,
    timeliness: evaluation.cumplimiento,
    value: evaluation.costo_valor,
    communication: evaluation.comunicacion,
    safety: evaluation.seguridad_orden,
  };
  return scores[key];
}

function localDate(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function SupplierDetail({ supplierId }: { supplierId: string }) {
  const [supplier, setSupplier] = useState<Supplier>();
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [works, setWorks] = useState<Work[]>([]);
  const [editingProfile, setEditingProfile] = useState(false);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [editingEvaluation, setEditingEvaluation] = useState<Evaluation>();
  const [evaluationWorkId, setEvaluationWorkId] = useState('');
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [detail, specialtyList, workList] = await Promise.all([
        apiJson<Supplier>(`/suppliers/${supplierId}`),
        apiJson<Specialty[]>('/supplier-specialties'),
        apiJson<Work[]>('/works'),
      ]);
      setSupplier(detail);
      setSpecialties(specialtyList);
      setWorks(workList);
      const firstAssignment = detail.assignments.find((item) => item.activo);
      setEvaluationWorkId((current) => current || firstAssignment?.obra_id || '');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible cargar el proveedor.');
    } finally {
      setBusy(false);
    }
  }, [supplierId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const assignedWorkIds = useMemo(
    () => new Set(supplier?.assignments.filter((item) => item.activo).map((item) => item.obra_id)),
    [supplier?.assignments],
  );
  const eligibleWorks = supplier?.assignments.filter((item) => item.activo) || [];
  const eligibleExpenses = supplier?.expenses.filter((item) => item.obra_id === evaluationWorkId) || [];

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiJson(`/suppliers/${supplierId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: form.get('name'), legal_name: form.get('legal_name') || null,
          tax_id: form.get('tax_id') || null, contact_name: form.get('contact_name') || null,
          phone: form.get('phone') || null, whatsapp: form.get('whatsapp') || null,
          email: form.get('email') || null, address: form.get('address') || null,
          coverage: form.get('coverage') || null, notes: form.get('notes') || null,
          specialty_ids: form.getAll('specialty_ids'),
        }),
      });
      setEditingProfile(false);
      setMessage('Datos del proveedor actualizados.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible actualizar el perfil.');
    } finally { setBusy(false); }
  }

  async function toggleAssignment(work: Work) {
    if (!supplier) return;
    setBusy(true);
    try {
      const active = assignedWorkIds.has(work.id);
      await apiJson(`/suppliers/${supplierId}/works/${work.id}`, {
        method: active ? 'DELETE' : 'PUT',
        ...(active ? {} : { body: JSON.stringify({ notes: null }) }),
      });
      setMessage(active ? `Proveedor retirado de ${work.nombre}.` : `Proveedor asignado a ${work.nombre}.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible cambiar la asignación.');
    } finally { setBusy(false); }
  }

  async function saveEvaluation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = editingEvaluation;
    setBusy(true);
    try {
      const payload = {
        work_id: form.get('work_id'), expense_id: form.get('expense_id') || null,
        work_description: form.get('work_description'), service_date: form.get('service_date'),
        quality: Number(form.get('quality')), timeliness: Number(form.get('timeliness')),
        value: Number(form.get('value')), communication: Number(form.get('communication')),
        safety: Number(form.get('safety')), comment: form.get('comment') || null,
      };
      await apiJson(`/suppliers/${supplierId}/evaluations${current ? `/${current.id}` : ''}`, {
        method: current ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      setShowEvaluation(false);
      setEditingEvaluation(undefined);
      setMessage(current ? 'Evaluación actualizada.' : 'Evaluación registrada.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible guardar la evaluación.');
    } finally { setBusy(false); }
  }

  async function archiveOrRestore() {
    if (!supplier) return;
    const reason = supplier.activo
      ? window.prompt('Motivo para archivar al proveedor (mínimo 5 caracteres):')
      : null;
    if (supplier.activo && (!reason || reason.trim().length < 5)) return;
    setBusy(true);
    try {
      await apiJson(`/suppliers/${supplierId}${supplier.activo ? '' : '/restore'}`, {
        method: 'POST',
        ...(supplier.activo ? { method: 'DELETE', body: JSON.stringify({ reason }) } : {}),
      });
      setMessage(supplier.activo ? 'Proveedor archivado; su historial permanece disponible.' : 'Proveedor reactivado.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible cambiar el estado.');
    } finally { setBusy(false); }
  }

  async function voidEvaluation(evaluation: Evaluation) {
    const reason = window.prompt('Motivo para anular la evaluación (mínimo 5 caracteres):');
    if (!reason || reason.trim().length < 5) return;
    setBusy(true);
    try {
      await apiJson(`/suppliers/${supplierId}/evaluations/${evaluation.id}`, {
        method: 'DELETE', body: JSON.stringify({ reason }),
      });
      setMessage('Evaluación anulada; se conserva en la auditoría.');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible anular la evaluación.');
    } finally { setBusy(false); }
  }

  if (!supplier) return <AppShell active="/proveedores"><PageHeader eyebrow="Directorio" title="Ficha de proveedor" description="Cargando información…" />{message ? <div className="notice error">{message}</div> : null}</AppShell>;

  return <AppShell active="/proveedores">
    <div className="detail-back"><Link href="/proveedores">← Volver al directorio</Link></div>
    <PageHeader eyebrow="Ficha de proveedor" title={supplier.nombre} description={supplier.razon_social || 'Perfil comercial y desempeño por trabajo'} actions={supplier.permissions.can_manage ? <><button className="btn secondary" onClick={() => setEditingProfile(true)}>Editar perfil</button><button className={`btn ${supplier.activo ? 'danger' : ''}`} onClick={() => void archiveOrRestore()} disabled={busy}>{supplier.activo ? 'Archivar' : 'Reactivar'}</button></> : undefined} />
    {message ? <div className="notice" role="status">{message}</div> : null}
    <section className="supplier-identity panel">
      <div className="supplier-identity-mark">{supplier.nombre.slice(0, 2).toLocaleUpperCase('es-MX')}</div>
      <div><StatusPill tone={supplier.activo ? 'green' : 'red'}>{supplier.activo ? 'Activo' : 'Archivado'}</StatusPill><div className="specialty-chips">{supplier.specialties.map((item) => <span key={item.id}>{item.nombre}</span>)}{!supplier.specialties.length ? <span>Sin especialidad</span> : null}</div></div>
      <dl><div><dt>Calificación global</dt><dd>{supplier.rating == null ? 'Sin evaluar' : `${displayScore(supplier.rating)} / 5`}</dd></div><div><dt>Trabajos evaluados</dt><dd>{supplier.evaluation_count}</dd></div><div><dt>Obras activas</dt><dd>{supplier.work_count}</dd></div>{supplier.permissions.can_manage ? <div><dt>Gasto validado</dt><dd>{currency.format(Number(supplier.validated_spend || 0))}</dd></div> : null}</dl>
    </section>
    <div className="supplier-detail-grid">
      <section className="panel"><div className="panel-header"><div><h2>Contacto</h2><p>Información disponible para todo el equipo</p></div></div><dl className="contact-list"><div><dt>Contacto</dt><dd>{supplier.contacto || 'Sin registrar'}</dd></div><div><dt>Teléfono</dt><dd>{supplier.telefono ? <a href={`tel:${supplier.telefono}`}>{supplier.telefono}</a> : 'Sin registrar'}</dd></div><div><dt>WhatsApp</dt><dd>{supplier.whatsapp ? <a href={`https://wa.me/${supplier.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">{supplier.whatsapp}</a> : 'Sin registrar'}</dd></div><div><dt>Correo</dt><dd>{supplier.email ? <a href={`mailto:${supplier.email}`}>{supplier.email}</a> : 'Sin registrar'}</dd></div><div><dt>RFC</dt><dd>{supplier.rfc || 'Sin registrar'}</dd></div><div><dt>Cobertura</dt><dd>{supplier.cobertura || 'Sin registrar'}</dd></div><div className="full"><dt>Dirección</dt><dd>{supplier.direccion || 'Sin registrar'}</dd></div><div className="full"><dt>Notas</dt><dd>{supplier.notas || 'Sin notas'}</dd></div></dl></section>
      <section className="panel"><div className="panel-header"><div><h2>Perfil de desempeño</h2><p>Promedio de evaluaciones vigentes</p></div></div><div className="score-profile">{criteria.map(([key, label]) => { const score = supplier[key]; return <div key={key}><div><span>{label}</span><strong>{displayScore(score)}</strong></div><div className="bar-track"><div className="bar-fill" style={{ '--width': `${Number(score || 0) * 20}%`, '--color': '#c66a3d' } as React.CSSProperties} /></div></div>; })}</div></section>
    </div>
    <section className="panel supplier-work-panel"><div className="panel-header"><div><h2>Obras asignadas</h2><p>Sólo estos proveedores aparecen al capturar gastos en cada obra</p></div></div><div className="assignment-grid">{works.map((work) => { const active = assignedWorkIds.has(work.id); return <button key={work.id} type="button" className={active ? 'assignment-card active' : 'assignment-card'} disabled={!supplier.permissions.can_manage || busy || !supplier.activo} onClick={() => void toggleAssignment(work)}><span><strong>{work.nombre}</strong><small>{active ? 'Disponible para gastos' : 'Sin asignar'}</small></span><StatusPill tone={active ? 'green' : 'navy'}>{active ? 'Asignado' : 'Asignar'}</StatusPill></button>; })}{works.length === 0 ? <p className="empty-state">No hay obras disponibles.</p> : null}</div></section>
    <section className="panel evaluation-panel"><div className="panel-header"><div><h2>Historial de evaluaciones</h2><p>Calificación por trabajo: promedio simple de cinco criterios</p></div>{supplier.permissions.can_manage && supplier.activo ? <button className="btn" disabled={!eligibleWorks.length} onClick={() => { setEditingEvaluation(undefined); setShowEvaluation(true); }}><PlusIcon />Evaluar trabajo</button> : null}</div><div className="evaluation-list">{supplier.evaluations.map((evaluation) => <article className={evaluation.vigente ? 'evaluation-row' : 'evaluation-row void'} key={evaluation.id}><div className="evaluation-score"><strong>{displayScore(evaluation.calificacion)}</strong><span>/ 5</span></div><div><div className="evaluation-title"><strong>{evaluation.trabajo}</strong><StatusPill tone={evaluation.vigente ? 'green' : 'red'}>{evaluation.vigente ? 'Vigente' : 'Anulada'}</StatusPill></div><p>{evaluation.obra_nombre} · {evaluation.fecha_servicio}{evaluation.gasto_concepto ? ` · ${evaluation.gasto_concepto}` : ''}</p><div className="mini-scores"><span>Calidad {evaluation.calidad}</span><span>Cumplimiento {evaluation.cumplimiento}</span><span>Valor {evaluation.costo_valor}</span><span>Comunicación {evaluation.comunicacion}</span><span>Seguridad {evaluation.seguridad_orden}</span></div>{evaluation.comentario ? <blockquote>{evaluation.comentario}</blockquote> : null}{!evaluation.vigente && evaluation.motivo_anulacion ? <small>Motivo: {evaluation.motivo_anulacion}</small> : null}</div>{supplier.permissions.can_manage && evaluation.vigente ? <div className="evaluation-actions"><button className="text-action" onClick={() => { setEditingEvaluation(evaluation); setEvaluationWorkId(evaluation.obra_id || ''); setShowEvaluation(true); }}>Editar</button><button className="text-action danger" onClick={() => void voidEvaluation(evaluation)}>Anular</button></div> : null}</article>)}{supplier.evaluations.length === 0 ? <p className="empty-state">Aún no hay trabajos evaluados.</p> : null}</div></section>
    {editingProfile ? <div className="dialog-backdrop" role="presentation" onMouseDown={() => setEditingProfile(false)}><form className="confirm-dialog supplier-dialog" onSubmit={saveProfile} onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">Edición administrativa</span><h2>Actualizar proveedor</h2><SupplierFields specialties={specialties} supplier={supplier} /><div className="dialog-actions"><button type="button" className="btn secondary" onClick={() => setEditingProfile(false)}>Cancelar</button><button className="btn" disabled={busy}>Guardar cambios</button></div></form></div> : null}
    {showEvaluation ? <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowEvaluation(false)}><form className="confirm-dialog evaluation-dialog" onSubmit={saveEvaluation} onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">Desempeño por servicio</span><h2>{editingEvaluation ? 'Editar evaluación' : 'Evaluar trabajo'}</h2><div className="form-grid two"><label className="field">Obra<select name="work_id" value={evaluationWorkId} onChange={(event) => setEvaluationWorkId(event.target.value)} required><option value="">Seleccionar obra</option>{eligibleWorks.map((item) => <option key={item.obra_id} value={item.obra_id}>{item.obra}</option>)}</select></label><label className="field">Fecha del servicio<input name="service_date" type="date" defaultValue={editingEvaluation?.fecha_servicio || localDate()} required /></label><label className="field full">Trabajo o servicio<textarea name="work_description" defaultValue={editingEvaluation?.trabajo || ''} required /></label><label className="field full">Gasto relacionado (opcional)<select name="expense_id" defaultValue={editingEvaluation?.gasto_id || ''}><option value="">Sin gasto específico</option>{eligibleExpenses.map((expense) => <option key={expense.id} value={expense.id}>{expense.fecha} · {expense.concepto} · {currency.format(Number(expense.importe))}</option>)}</select></label>{criteria.map(([key, label]) => <label className="field" key={key}>{label}<select name={key} defaultValue={evaluationScore(editingEvaluation, key)} required>{[5, 4, 3, 2, 1].map((score) => <option key={score} value={score}>{score} — {score === 5 ? 'Excelente' : score === 4 ? 'Muy bueno' : score === 3 ? 'Aceptable' : score === 2 ? 'Deficiente' : 'Crítico'}</option>)}</select></label>)}<label className="field full">Comentario<textarea name="comment" defaultValue={editingEvaluation?.comentario || ''} /></label></div><div className="dialog-actions"><button type="button" className="btn secondary" onClick={() => setShowEvaluation(false)}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : 'Guardar evaluación'}</button></div></form></div> : null}
  </AppShell>;
}
