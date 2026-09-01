'use client';

import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { PlusIcon } from '@/components/icons';
import { PageHeader } from '@/components/page-header';
import { apiJson, getSupabaseBrowserClient } from '@/lib/auth';

type Work = { id: string; nombre: string };
type Area = { id: string; nombre: string };
type Item = {
  budget_item_id: string;
  area_id: string;
  codigo: string;
  descripcion: string;
  clase: string;
};
type Supplier = { id: string; nombre: string };
type Catalog = { areas: Area[]; items: Item[]; suppliers: Supplier[] };

export default function ExpensesPage() {
  const [works, setWorks] = useState<Work[]>([]);
  const [workId, setWorkId] = useState('');
  const [catalog, setCatalog] = useState<Catalog>({ areas: [], items: [], suppliers: [] });
  const [areaId, setAreaId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const filteredItems = useMemo(
    () => catalog.items.filter((item) => item.area_id === areaId),
    [catalog.items, areaId],
  );

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
        setCatalog(result);
        setAreaId(result.areas[0]?.id || '');
      })
      .catch((error: Error) => setMessage(error.message));
  }, [workId]);

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
          budget_item_id: form.get('budget_item_id'),
          supplier_id: form.get('supplier_id') || null,
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
        if (uploadError) throw new Error(`Gasto creado, pero falló el comprobante: ${uploadError.message}`);
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

  return (
    <AppShell active="/gastos">
      <PageHeader eyebrow="Captura de campo" title="Nuevo gasto" description="Registra el movimiento contra una partida vigente y conserva la evidencia del comprobante." />
      {message ? <div className="notice" role="status"><strong>{message}</strong></div> : null}
      <form className="panel form-panel" onSubmit={submit}>
        <div className="form-section"><h2>Ubicación presupuestal</h2><p>Solo aparecen obras asignadas al usuario y partidas de la versión vigente.</p><div className="form-grid three"><label className="field">Obra<select value={workId} onChange={(event) => setWorkId(event.target.value)} required><option value="">Seleccionar</option>{works.map((work) => <option key={work.id} value={work.id}>{work.nombre}</option>)}</select></label><label className="field">Área<select value={areaId} onChange={(event) => setAreaId(event.target.value)} required><option value="">Seleccionar</option>{catalog.areas.map((area) => <option key={area.id} value={area.id}>{area.nombre}</option>)}</select></label><label className="field">Partida<select name="budget_item_id" required><option value="">Seleccionar partida vigente</option>{filteredItems.map((item) => <option key={item.budget_item_id} value={item.budget_item_id}>{item.codigo} · {item.descripcion}</option>)}</select></label></div></div>
        <div className="form-section"><h2>Datos del movimiento</h2><div className="form-grid three"><label className="field">Fecha<input name="spent_on" type="date" defaultValue="2026-08-29" required /></label><label className="field">Proveedor<select name="supplier_id"><option value="">Sin proveedor</option>{catalog.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.nombre}</option>)}</select></label><label className="field">Importe<input name="amount" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="$ 0.00" required /></label><label className="field">Folio<input name="folio" placeholder="A-2841" /></label><label className="field full">Concepto<textarea name="concept" placeholder="Describe material, trabajo o servicio…" required /></label></div></div>
        <div className="form-section"><h2>Comprobante</h2><p>Se guarda en un bucket privado asociado a la obra y al gasto.</p><label className="field"><input name="receipt" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" /></label></div>
        <div className="form-section"><div className="header-actions"><button type="reset" className="btn secondary">Cancelar</button><button type="submit" className="btn" disabled={busy || filteredItems.length === 0}><PlusIcon />{busy ? 'Guardando…' : 'Guardar pendiente'}</button></div></div>
      </form>
    </AppShell>
  );
}
