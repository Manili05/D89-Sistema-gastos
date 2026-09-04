'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PlusIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { apiJson, getSupabaseBrowserClient } from '@/lib/auth';

type Work = { id: string; nombre: string };
type CatalogOption = { id: string; nombre: string };
type DependentOption = CatalogOption & { partida_id: string };
type Catalog = {
  areas: CatalogOption[];
  expense_partidas: CatalogOption[];
  expense_subitems: DependentOption[];
  expense_categories: CatalogOption[];
  suppliers: CatalogOption[];
};

const emptyCatalog: Catalog = {
  areas: [],
  expense_partidas: [],
  expense_subitems: [],
  expense_categories: [],
  suppliers: [],
};

function localDate(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

export default function ExpensesPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [catalog, setCatalog] = useState<Catalog>(emptyCatalog);
  const [areaId, setAreaId] = useState('');
  const [partidaId, setPartidaId] = useState('');
  const [subpartidaId, setSubpartidaId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [today] = useState(localDate);

  const subpartidas = useMemo(
    () => catalog.expense_subitems.filter((item) => item.partida_id === partidaId),
    [catalog.expense_subitems, partidaId],
  );
  const categories = catalog.expense_categories;

  useEffect(() => {
    apiJson<Work[]>('/works')
      .then((result) => {
        setWorks(result);
        setWorkId(result[0]?.id || '');
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (!workId) return;
    apiJson<Catalog>(`/works/${workId}/catalog`)
      .then((result) => {
        const initialPartida = result.expense_partidas[0]?.id || '';
        setCatalog(result);
        setAreaId(result.areas[0]?.id || '');
        setPartidaId(initialPartida);
        setSubpartidaId(
          result.expense_subitems.find((item) => item.partida_id === initialPartida)?.id || '',
        );
        setCategoryId(
          result.expense_categories[0]?.id || '',
        );
        setSupplierId(result.suppliers[0]?.id || '');
      })
      .catch((error: Error) => setMessage(error.message));
  }, [workId]);

  function changePartida(nextPartidaId: string) {
    setPartidaId(nextPartidaId);
    setSubpartidaId(
      catalog.expense_subitems.find((item) => item.partida_id === nextPartidaId)?.id || '',
    );
    setCategoryId(
      catalog.expense_categories[0]?.id || '',
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setMessage('');
    try {
      const expense = await apiJson<{ id: string }>('/expenses', {
        method: 'POST',
        body: JSON.stringify({
          work_id: workId,
          area_id: areaId,
          expense_item_id: partidaId,
          expense_subitem_id: subpartidaId,
          expense_category_id: categoryId,
          supplier_id: supplierId,
          spent_on: form.get('spent_on'),
          concept: form.get('concept'),
          folio: form.get('folio') || null,
          amount: form.get('amount'),
          state: 'pendiente',
        }),
      });
      const receipt = form.get('receipt');
      if (receipt instanceof File && receipt.size > 0) {
        const safeName = receipt.name.replace(/[^a-zA-Z0-9._-]/g, '-');
        const path = `${workId}/${expense.id}/${Date.now()}-${safeName}`;
        const { error: uploadError } = await getSupabaseBrowserClient()
          .storage.from('comprobantes')
          .upload(path, receipt, { contentType: receipt.type, upsert: false });
        if (uploadError) {
          throw new Error(`Gasto creado, pero falló el comprobante: ${uploadError.message}`);
        }
        await apiJson(`/expenses/${expense.id}/receipt`, {
          method: 'PATCH',
          body: JSON.stringify({ path }),
        });
      }
      setMessage('Gasto guardado como pendiente. Quedó listo para validación semanal.');
      formElement.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No fue posible guardar el gasto.');
    } finally {
      setBusy(false);
    }
  }

  const hierarchyReady = Boolean(workId && areaId && partidaId && subpartidaId && categoryId);

  return (
    <AppShell active="/gastos">
      <PageHeader
        eyebrow="Captura semanal"
        title="Nuevo gasto"
        description="Clasifica cada movimiento de lo general a lo específico y conserva su comprobante."
      />
      {message ? <div className="notice" role="status"><strong>{message}</strong></div> : null}
      <form className="panel form-panel" onSubmit={submit}>
        <div className="form-section">
          <h2>Clasificación del gasto</h2>
          <p>Sigue el orden Obra → Área → Partida → Subpartida → Categoría → Proveedor.</p>
          <div className="form-grid three">
            <label className="field">Obra
              <select aria-label="Obra" value={workId} onChange={(event) => setWorkId(event.target.value)} required>
                <option value="">Seleccionar obra</option>
                {works.map((work) => <option key={work.id} value={work.id}>{work.nombre}</option>)}
              </select>
            </label>
            <label className="field">Área
              <select aria-label="Área" value={areaId} onChange={(event) => setAreaId(event.target.value)} required>
                <option value="">Seleccionar área</option>
                {catalog.areas.map((area) => <option key={area.id} value={area.id}>{area.nombre}</option>)}
              </select>
            </label>
            <label className="field">Partida
              <select aria-label="Partida" value={partidaId} onChange={(event) => changePartida(event.target.value)} required>
                <option value="">Seleccionar partida</option>
                {catalog.expense_partidas.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}
              </select>
            </label>
            <label className="field">Subpartida
              <select aria-label="Subpartida" value={subpartidaId} onChange={(event) => setSubpartidaId(event.target.value)} required>
                <option value="">Seleccionar subpartida</option>
                {subpartidas.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}
              </select>
            </label>
            <label className="field">Categoría
              <select aria-label="Categoría" value={categoryId} onChange={(event) => setCategoryId(event.target.value)} required>
                <option value="">Seleccionar categoría</option>
                {categories.map((item) => <option key={item.id} value={item.id}>{item.nombre}</option>)}
              </select>
            </label>
            <label className="field">Proveedor
              <select aria-label="Proveedor" value={supplierId} onChange={(event) => setSupplierId(event.target.value)} required>
                <option value="">Seleccionar proveedor</option>
                {catalog.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.nombre}</option>)}
              </select>
            </label>
          </div>
          {workId && catalog.suppliers.length === 0 ? <p className="notice">Esta obra no tiene proveedores asignados. <Link className="text-action" href="/proveedores">Consulta el directorio</Link> o solicita a administración que asigne uno.</p> : null}
        </div>
        <div className="form-section">
          <h2>Datos del movimiento</h2>
          <div className="form-grid three">
            <label className="field">Fecha<input name="spent_on" type="date" defaultValue={today} required /></label>
            <label className="field">Importe<input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="$ 0.00" required /></label>
            <label className="field">Folio<input name="folio" placeholder="A-2841" /></label>
            <label className="field full">Concepto<textarea name="concept" placeholder="Describe material, trabajo o servicio…" required /></label>
          </div>
        </div>
        <div className="form-section">
          <h2>Comprobante</h2>
          <p>Se guarda en un bucket privado asociado a la obra y al gasto.</p>
          <label className="field"><input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label>
        </div>
        <div className="form-section">
          <div className="header-actions">
            <button type="reset" className="btn secondary">Cancelar</button>
            <button type="submit" className="btn" disabled={busy || !hierarchyReady || !supplierId}><PlusIcon />{busy ? 'Guardando…' : 'Guardar pendiente'}</button>
          </div>
        </div>
      </form>
    </AppShell>
  );
}
