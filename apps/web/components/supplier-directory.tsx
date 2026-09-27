'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from './app-shell';
import { ArrowIcon, PlusIcon, SuppliersIcon, UploadIcon } from './icons';
import { PageHeader } from './page-header';
import { StatusPill } from './status-pill';
import type { components } from '@/lib/api.generated';
import { apiFetch, apiJson } from '@/lib/auth';

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

type CsfExtractionResponse = components['schemas']['CsfExtractionResponse'];
type FiscalFields = { legal_name: string; tax_id: string; tax_regime: string; postal_code: string };

const CSF_MAX_BYTES = 10 * 1024 * 1024;
const MANUAL_FALLBACK = 'Puedes capturar los datos manualmente.';
const CSF_ERRORS: Record<number, string> = {
  401: 'Tu sesión expiró. Vuelve a ingresar para usar la extracción.',
  403: 'Sólo administración puede extraer datos de una constancia.',
  413: 'El PDF supera el límite de 10 MB.',
  415: 'El archivo no es un PDF válido.',
  429: 'Se agotó el presupuesto mensual de IA.',
  502: 'La IA no pudo leer la constancia con certeza.',
  503: 'El servicio de IA no está disponible en este momento.',
};

/** POST the PDF as multipart; apiFetch adds the session JWT and leaves the boundary to the browser. */
export async function extractCsf(file: File, signal?: AbortSignal): Promise<CsfExtractionResponse> {
  const body = new FormData();
  body.append('file', file, file.name);
  let response: Response;
  try {
    response = await apiFetch('/suppliers/extract-csf', { method: 'POST', body, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof Error && error.message.includes('sesión')) throw error;
    throw new Error(CSF_ERRORS[503]);
  }
  if (!response.ok) {
    throw new Error(CSF_ERRORS[response.status] || `La extracción falló (${response.status}).`);
  }
  return response.json() as Promise<CsfExtractionResponse>;
}

/** Shared by create and edit so every supplier field, fiscal data included, is always sent. */
export function supplierPayload(form: FormData): Record<string, unknown> {
  const optional = (name: string) => form.get(name) || null;
  return {
    name: form.get('name'), legal_name: optional('legal_name'), tax_id: optional('tax_id'),
    tax_regime: optional('tax_regime'), postal_code: optional('postal_code'),
    contact_name: optional('contact_name'), phone: optional('phone'), whatsapp: optional('whatsapp'),
    email: optional('email'), address: optional('address'), coverage: optional('coverage'),
    notes: optional('notes'), specialty_ids: form.getAll('specialty_ids'),
  };
}

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
  const [analyzing, setAnalyzing] = useState(false);
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
    if (analyzing) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setMessage('');
    try {
      await apiJson('/suppliers', { method: 'POST', body: JSON.stringify(supplierPayload(form)) });
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
    {showCreate ? <div className="dialog-backdrop" role="presentation" onMouseDown={() => setShowCreate(false)}><form className="confirm-dialog supplier-dialog" onSubmit={createSupplier} onMouseDown={(event) => event.stopPropagation()} aria-busy={analyzing || busy}><span className="eyebrow">Alta de proveedor</span><h2>Nuevo contacto comercial</h2><p>Los datos bancarios no forman parte de este directorio.</p><SupplierFields specialties={specialties} autofill onAnalyzingChange={setAnalyzing} /><div className="dialog-actions"><button type="button" className="btn secondary" onClick={() => setShowCreate(false)}>Cancelar</button><button className="btn" disabled={busy || analyzing}>{analyzing ? 'Analizando documento con IA…' : busy ? 'Guardando…' : 'Crear proveedor'}</button></div></form></div> : null}
  </AppShell>;
}

export function SupplierFields({
  specialties,
  supplier,
  autofill = false,
  onAnalyzingChange,
}: {
  specialties: Specialty[];
  supplier?: Supplier & {
    rfc?: string | null; regimen_fiscal?: string | null; codigo_postal?: string | null;
    direccion?: string | null; notas?: string | null;
  };
  autofill?: boolean;
  onAnalyzingChange?: (analyzing: boolean) => void;
}) {
  const selected = new Set(supplier?.specialties.map((item) => item.id));
  // Fiscal fields are controlled so a CSF extraction can fill them in place
  // without resetting whatever else the user already typed.
  const [fiscal, setFiscal] = useState<FiscalFields>({
    legal_name: supplier?.razon_social || '', tax_id: supplier?.rfc || '',
    tax_regime: supplier?.regimen_fiscal || '', postal_code: supplier?.codigo_postal || '',
  });
  const [analyzing, setAnalyzing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'error'; text: string; reasons?: string[] } | null>(null);
  const controller = useRef<AbortController | null>(null);

  // Abort an in-flight extraction if the dialog closes.
  useEffect(() => () => controller.current?.abort(), []);

  function setField(name: keyof FiscalFields, value: string) {
    setFiscal((current) => ({ ...current, [name]: value }));
  }

  function setBusy(value: boolean) {
    setAnalyzing(value);
    onAnalyzingChange?.(value);
  }

  async function analyze(file: File) {
    if (analyzing) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setNotice({ tone: 'error', text: `${CSF_ERRORS[415]} ${MANUAL_FALLBACK}` });
      return;
    }
    if (file.size > CSF_MAX_BYTES) {
      setNotice({ tone: 'error', text: `${CSF_ERRORS[413]} ${MANUAL_FALLBACK}` });
      return;
    }
    controller.current = new AbortController();
    setBusy(true);
    setNotice(null);
    try {
      const { extraction } = await extractCsf(file, controller.current.signal);
      // Only overwrite with values the AI could read; keep manual input otherwise.
      setFiscal((current) => ({
        legal_name: extraction.razon_social ?? current.legal_name,
        tax_id: extraction.rfc ?? current.tax_id,
        tax_regime: extraction.regimen_fiscal ?? current.tax_regime,
        postal_code: extraction.codigo_postal ?? current.postal_code,
      }));
      setNotice(extraction.requiere_validacion_humana
        ? { tone: 'warning', text: 'Datos cargados parcialmente. Revisa y corrige antes de guardar:', reasons: extraction.motivos_revision }
        : { tone: 'success', text: 'Datos cargados desde la constancia. Revísalos antes de guardar.' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const detail = error instanceof Error ? error.message : CSF_ERRORS[503];
      setNotice({ tone: 'error', text: `${detail} ${MANUAL_FALLBACK}` });
    } finally {
      controller.current = null;
      setBusy(false);
    }
  }

  return <>
    {autofill && <div className="csf-autofill">
      <label className={`dropzone compact${analyzing ? ' busy' : ''}`}><span><span className="dropzone-icon"><UploadIcon size={22} /></span><strong>{analyzing ? 'Analizando documento con IA…' : 'Auto-rellenar desde Constancia (PDF)'}</strong><p>{analyzing ? 'Esto puede tardar unos segundos.' : 'Constancia de Situación Fiscal del SAT · máximo 10 MB'}</p><input type="file" accept=".pdf,application/pdf" aria-label="Auto-rellenar desde Constancia (PDF)" disabled={analyzing} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void analyze(file); }} /></span></label>
      {analyzing && <p className="sr-only" role="status">Analizando documento con IA…</p>}
      {notice && <div className={`notice ${notice.tone === 'warning' ? '' : notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}{notice.reasons?.length ? <ul>{notice.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}</div>}
    </div>}
    <fieldset className="form-grid two supplier-form-grid" disabled={analyzing} style={{ border: 0, padding: 0, minWidth: 0 }}>
    <label className="field">Nombre comercial<input name="name" defaultValue={supplier?.nombre || ''} required minLength={2} /></label>
    <label className="field">Razón social<input name="legal_name" value={fiscal.legal_name} onChange={(event) => setField('legal_name', event.target.value)} /></label>
    <label className="field">RFC<input name="tax_id" value={fiscal.tax_id} onChange={(event) => setField('tax_id', event.target.value)} minLength={12} maxLength={13} /></label>
    <label className="field">Régimen fiscal<input name="tax_regime" value={fiscal.tax_regime} onChange={(event) => setField('tax_regime', event.target.value)} maxLength={250} /></label>
    <label className="field">Código postal fiscal<input name="postal_code" value={fiscal.postal_code} onChange={(event) => setField('postal_code', event.target.value)} inputMode="numeric" pattern="[0-9]{5}" maxLength={5} title="5 dígitos" /></label>
    <label className="field">Persona de contacto<input name="contact_name" defaultValue={supplier?.contacto || ''} /></label>
    <label className="field">Teléfono<input name="phone" defaultValue={supplier?.telefono || ''} inputMode="tel" /></label>
    <label className="field">WhatsApp<input name="whatsapp" defaultValue={supplier?.whatsapp || ''} inputMode="tel" /></label>
    <label className="field">Correo<input name="email" defaultValue={supplier?.email || ''} type="email" /></label>
    <label className="field">Cobertura<input name="coverage" defaultValue={supplier?.cobertura || ''} placeholder="Toluca y zona metropolitana" /></label>
    <label className="field full">Dirección<input name="address" defaultValue={supplier?.direccion || ''} /></label>
    <fieldset className="specialty-field full"><legend>Especialidades</legend><div>{specialties.map((item) => <label key={item.id}><input name="specialty_ids" type="checkbox" value={item.id} defaultChecked={selected.has(item.id)} />{item.nombre}</label>)}</div></fieldset>
    <label className="field full">Notas<textarea name="notes" defaultValue={supplier?.notas || ''} placeholder="Condiciones, referencias o información útil para el equipo" /></label>
    </fieldset>
  </>;
}
