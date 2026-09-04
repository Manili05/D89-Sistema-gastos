'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from './app-shell';
import { ArrowIcon, PlusIcon, SuppliersIcon } from './icons';
import { PageHeader } from './page-header';
import { StatusPill } from './status-pill';
import { apiJson } from '@/lib/auth';

type Specialty = { id: string; nombre: string; activo: boolean; supplier_count: number };
type Supplier = {
  id: string;
  nombre: string;
  razon_social: string | null;
  contacto: string | null;
  telefono: string | null;
  whatsapp: string | null;
  email: string | null;
  cobertura: string | null;
  activo: boolean;
  specialties: { id: string; nombre: string }[];
  rating: number | string | null;
  evaluation_count: number;
  work_count: number;
};
type SupplierList = {
  items: Supplier[];
  total: number;
  permissions: { can_manage: boolean };
};
type Analytics = {
  summary: {
    active_suppliers: number;
    archived_suppliers: number;
    evaluations: number;
    average_rating: number | string | null;
  };
};

const emptyAnalytics: Analytics = {
  summary: { active_suppliers: 0, archived_suppliers: 0, evaluations: 0, average_rating: null },
};

function rating(value: number | string | null): string {
  return value == null ? 'Sin evaluar' : `${Number(value).toFixed(1)} / 5`;
}

export function SupplierDirectory() {
  const [suppliers, setSuppliers] = useState<SupplierList>({
    items: [], total: 0, permissions: { can_manage: false },
  });
  const [specialties, setSpecialties] = useState<Specialty[]>([]);
  const [analytics, setAnalytics] = useState<Analytics>(emptyAnalytics);
  const [query, setQuery] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [minimumRating, setMinimumRating] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sort, setSort] = useState('name');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');

  const loadDirectory = useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams({ sort });
      if (query.trim()) params.set('q', query.trim());
      if (specialtyId) params.set('specialty_id', specialtyId);
      if (minimumRating) params.set('min_rating', minimumRating);
      if (statusFilter === 'active') params.set('active', 'true');
      if (statusFilter === 'archived') params.set('active', 'false');
      if (statusFilter === 'all') params.set('include_archived', 'true');
      const [list, metrics, specialtyList] = await Promise.all([
        apiJson<SupplierList>(`/suppliers?${params}`),
        apiJson<Analytics>('/suppliers/analytics'),
        apiJson<Specialty[]>('/supplier-specialties'),
      ]);
      setSuppliers(list);
      setAnalytics(metrics);
      setSpecialties(specialtyList);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible cargar el directorio.');
    } finally {
      setBusy(false);
    }
  }, [minimumRating, query, sort, specialtyId, statusFilter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadDirectory(), 180);
    return () => window.clearTimeout(timeout);
  }, [loadDirectory]);

  async function createSupplier(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      await apiJson('/suppliers', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'), legal_name: form.get('legal_name') || null,
          tax_id: form.get('tax_id') || null, contact_name: form.get('contact_name') || null,
          phone: form.get('phone') || null, whatsapp: form.get('whatsapp') || null,
          email: form.get('email') || null, address: form.get('address') || null,
          coverage: form.get('coverage') || null, notes: form.get('notes') || null,
          specialty_ids: form.getAll('specialty_ids'),
        }),
      });
      setShowCreate(false);
      setMessage('Proveedor agregado al directorio.');
      await loadDirectory();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible crear el proveedor.');
    } finally {
      setBusy(false);
    }
  }

  async function createSpecialty() {
    const name = window.prompt('Nombre de la nueva especialidad:')?.trim();
    if (!name || name.length < 2) return;
    setBusy(true);
    try {
      await apiJson('/supplier-specialties', {
        method: 'POST', body: JSON.stringify({ name }),
      });
      setMessage(`Especialidad “${name}” agregada.`);
      await loadDirectory();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible crear la especialidad.');
    } finally { setBusy(false); }
  }

  const summary = analytics.summary;
  return <AppShell active="/proveedores">
    <PageHeader
      eyebrow="Red de suministro"
      title="Directorio de proveedores"
      description="Contactos, especialidades, obras atendidas y desempeño histórico en un solo lugar."
      actions={suppliers.permissions.can_manage
        ? <><button className="btn secondary" type="button" onClick={() => void createSpecialty()}>Nueva especialidad</button><button className="btn" type="button" onClick={() => setShowCreate(true)}><PlusIcon />Nuevo proveedor</button></>
        : undefined}
    />
    {message ? <div className="notice" role="status">{message}</div> : null}
    <section className="metrics supplier-metrics">
      <article className="metric-card"><span className="metric-label">Proveedores activos</span><strong className="metric-value">{summary.active_suppliers}</strong><span className="metric-foot">Disponibles para asignar</span></article>
      <article className="metric-card"><span className="metric-label">Evaluaciones</span><strong className="metric-value">{summary.evaluations}</strong><span className="metric-foot">Trabajos calificados</span></article>
      <article className="metric-card"><span className="metric-label">Promedio de red</span><strong className="metric-value">{rating(summary.average_rating)}</strong><span className="metric-foot">Cinco criterios por servicio</span></article>
      <article className="metric-card"><span className="metric-label">Archivados</span><strong className="metric-value">{summary.archived_suppliers}</strong><span className="metric-foot">Historial conservado</span></article>
    </section>
    <section className="supplier-toolbar" aria-label="Filtros del directorio">
      <label className="field supplier-search">Buscar<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nombre, contacto, RFC o correo" /></label>
      <label className="field">Especialidad<select value={specialtyId} onChange={(event) => setSpecialtyId(event.target.value)}><option value="">Todas</option>{specialties.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}</select></label>
      <label className="field">Calificación<select value={minimumRating} onChange={(event) => setMinimumRating(event.target.value)}><option value="">Cualquiera</option><option value="4">4 o más</option><option value="3">3 o más</option><option value="2">2 o más</option></select></label>
      <label className="field">Estado<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="active">Activos</option><option value="archived">Archivados</option><option value="all">Todos</option></select></label>
      <label className="field">Orden<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="name">Nombre</option><option value="rating">Mejor calificación</option><option value="jobs">Más evaluados</option>{suppliers.permissions.can_manage ? <option value="spend">Mayor gasto</option> : null}</select></label>
    </section>
    <section className="supplier-results-head"><span>{busy ? 'Actualizando…' : `${suppliers.total} proveedor${suppliers.total === 1 ? '' : 'es'}`}</span><small>Selecciona una ficha para consultar obras, contactos y evaluaciones.</small></section>
    <div className="supplier-grid">
      {suppliers.items.map((supplier) => <Link className="supplier-card" href={`/proveedores/${supplier.id}`} key={supplier.id}>
        <div className="supplier-card-top"><span className="supplier-monogram">{supplier.nombre.slice(0, 2).toLocaleUpperCase('es-MX')}</span><StatusPill tone={supplier.activo ? 'green' : 'red'}>{supplier.activo ? 'Activo' : 'Archivado'}</StatusPill></div>
        <div><h2>{supplier.nombre}</h2><p>{supplier.razon_social || supplier.contacto || 'Perfil de proveedor'}</p></div>
        <div className="specialty-chips">{supplier.specialties.length ? supplier.specialties.map((item) => <span key={item.id}>{item.nombre}</span>) : <span>Sin especialidad</span>}</div>
        <dl className="supplier-card-stats"><div><dt>Calificación</dt><dd>{rating(supplier.rating)}</dd></div><div><dt>Trabajos</dt><dd>{supplier.evaluation_count}</dd></div><div><dt>Obras</dt><dd>{supplier.work_count}</dd></div></dl>
        <div className="supplier-contact"><span>{supplier.whatsapp || supplier.telefono || supplier.email || 'Sin contacto registrado'}</span><ArrowIcon /></div>
      </Link>)}
      {!busy && suppliers.items.length === 0 ? <div className="panel supplier-empty"><SuppliersIcon size={30} /><h2>No encontramos proveedores</h2><p>Ajusta los filtros o agrega el primer registro al directorio.</p></div> : null}
    </div>
    {showCreate ? <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowCreate(false)}><form className="confirm-dialog supplier-dialog" onSubmit={createSupplier} onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">Alta de proveedor</span><h2>Nuevo contacto comercial</h2><p>Los datos bancarios no forman parte de este directorio.</p><SupplierFields specialties={specialties} /><div className="dialog-actions"><button type="button" className="btn secondary" onClick={() => setShowCreate(false)}>Cancelar</button><button className="btn" disabled={busy}>{busy ? 'Guardando…' : 'Crear proveedor'}</button></div></form></div> : null}
  </AppShell>;
}

export function SupplierFields({
  specialties,
  supplier,
}: {
  specialties: Specialty[];
  supplier?: Supplier & { rfc?: string | null; direccion?: string | null; notas?: string | null };
}) {
  const selected = new Set(supplier?.specialties.map((item) => item.id));
  return <div className="form-grid two supplier-form-grid">
    <label className="field">Nombre comercial<input name="name" defaultValue={supplier?.nombre || ''} required minLength={2} /></label>
    <label className="field">Razón social<input name="legal_name" defaultValue={supplier?.razon_social || ''} /></label>
    <label className="field">RFC<input name="tax_id" defaultValue={supplier?.rfc || ''} minLength={12} maxLength={13} /></label>
    <label className="field">Persona de contacto<input name="contact_name" defaultValue={supplier?.contacto || ''} /></label>
    <label className="field">Teléfono<input name="phone" defaultValue={supplier?.telefono || ''} inputMode="tel" /></label>
    <label className="field">WhatsApp<input name="whatsapp" defaultValue={supplier?.whatsapp || ''} inputMode="tel" /></label>
    <label className="field">Correo<input name="email" defaultValue={supplier?.email || ''} type="email" /></label>
    <label className="field">Cobertura<input name="coverage" defaultValue={supplier?.cobertura || ''} placeholder="Toluca y zona metropolitana" /></label>
    <label className="field full">Dirección<input name="address" defaultValue={supplier?.direccion || ''} /></label>
    <fieldset className="specialty-field full"><legend>Especialidades</legend><div>{specialties.map((item) => <label key={item.id}><input name="specialty_ids" type="checkbox" value={item.id} defaultChecked={selected.has(item.id)} />{item.nombre}</label>)}</div></fieldset>
    <label className="field full">Notas<textarea name="notes" defaultValue={supplier?.notas || ''} placeholder="Condiciones, referencias o información útil para el equipo" /></label>
  </div>;
}
