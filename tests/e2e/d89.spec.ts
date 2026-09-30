import { type Locator, expect, test } from '@playwright/test';

const workId = '11111111-1111-4111-8111-111111111111';
const areaId = '22222222-2222-4222-8222-222222222222';
const budgetItemId = '33333333-3333-4333-8333-333333333333';
const importId = '55555555-5555-4555-8555-555555555555';
const expensePartidaId = '77777777-7777-4777-8777-777777777777';
const expenseSubpartidaId = '88888888-8888-4888-8888-888888888888';
const expenseCategoryId = '99999999-9999-4999-8999-999999999999';
const secondExpensePartidaId = '12121212-1212-4212-8212-121212121212';
const secondExpenseSubpartidaId = '13131313-1313-4313-8313-131313131313';
const supplierId = 'abababab-abab-4bab-8bab-abababababab';
const specialtyId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';

const previewData = {
  area_count: 1,
  item_count: 1,
  consolidated_item_count: 1,
  section_total_count: 1,
  rollup_total_count: 1,
  calculated_total_without_vat: '3.02',
  warnings: [],
  unclassified: [],
  section_mismatches: [],
  section_totals: [],
  items: [{
    sheet: 'Presupuesto', row: 20, area: 'General', work_class: 'PRELIMINARES',
    category: null, code: 'PRE-01', description: 'Trazo', unit: 'M2', quantity: '3',
    unit_price: '1.005', amount: '3.02',
  }],
};

/** Catalog of the mocked work (1 subpartida per partida, 1 category, 1 supplier). */
function workCatalog() {
  return {
    areas: [{ id: areaId, nombre: 'Oficina', ruta: ['OFICINA'], nivel: 0, seleccionable: true }],
    items: [{ budget_item_id: budgetItemId, area_id: areaId, codigo: 'ALB-05', descripcion: 'Firme de concreto', clase: 'ALBAÑILERÍAS' }],
    expense_partidas: [{ id: expensePartidaId, nombre: 'PRELIMINARES' }, { id: secondExpensePartidaId, nombre: 'ALBANILERIA' }],
    expense_subitems: [{ id: expenseSubpartidaId, partida_id: expensePartidaId, nombre: 'LIMPIEZA' }, { id: secondExpenseSubpartidaId, partida_id: secondExpensePartidaId, nombre: 'FIRMES Y HORMIGONES' }],
    expense_categories: [{ id: expenseCategoryId, nombre: 'MATERIAL' }],
    suppliers: [{ id: supplierId, nombre: 'Concretos Toluca' }],
    permissions: { can_manage_suppliers: true },
  };
}

/** Spend bucket of the overview breakdown (validated + pending = committed). */
function spend(name: string, validated: string, pending: string, count: number) {
  return {
    id: null, name, validated, pending, committed: String(Number(validated) + Number(pending)),
    expense_count: count, share_percent: '0',
  };
}

test.beforeEach(async ({ page }) => {
  let workDeleted = false;
  await page.route('**/auth/v1/token**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
        expires_in: 3600,
        token_type: 'bearer',
        user: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'admin@d89.mx',
          app_metadata: { role: 'admin' },
          user_metadata: {},
        },
      }),
    });
  });
  await page.route('**/auth/v1/logout**', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/auth/v1/recover**', async (route) => {
    await route.fulfill({ status: 200, json: {} });
  });
  await page.route('**/auth/v1/user', async (route) => {
    await route.fulfill({
      status: 200,
      json: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'admin@d89.mx',
        app_metadata: { role: 'admin' },
        user_metadata: {},
      },
    });
  });
  await page.route('**/api/v1/works', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{ id: workId, nombre: 'Infra Toluca', presupuesto: '1' }] });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/v1/dashboard', async (route) => {
    await route.fulfill({
      json: {
        works: workDeleted ? [] : [{ id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', presupuesto: '2624832.88', gasto: '18450', pendiente: '18450', cobrado: '75000', por_cobrar: '0', subcontratado: '45000', pagado_subcontratos: '18450' }],
        permissions: { can_delete_works: true },
        totals: workDeleted
          ? { budget: '0', spent: '0', available: '0', pending: '0', collected: '0', receivable: '0', subcontracted: '0', subcontract_paid: '0', cash_balance: '0' }
          : { budget: '2624832.88', spent: '18450', available: '2606382.88', pending: '18450', collected: '75000', receivable: '0', subcontracted: '45000', subcontract_paid: '18450', cash_balance: '56550' },
      },
    });
  });
  await page.route(new RegExp(`/api/v1/works/${workId}$`), async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', fecha_inicio: '2026-01-01', fecha_fin: null, estado: 'activa', areas: 1, partidas: 1, permissions: { can_manage: true, can_validate: true } } });
    } else {
      expect(route.request().method()).toBe('DELETE');
      expect(route.request().postDataJSON()).toEqual({ confirmation_name: 'Infra Toluca' });
      workDeleted = true;
      await route.fulfill({
        json: { id: workId, nombre: 'Infra Toluca', deleted: true, counts: {}, receipt_paths: [] },
      });
    }
  });
  await page.route(`**/api/v1/works/${workId}/overview**`, async (route) => {
    await route.fulfill({ json: {
      totals: { budget: '2624832.88', validated: '18450', committed: '22600', available: '2606382.88', projected_available: '2602232.88', execution_percent: '0.70', pending: '4150', pending_count: 1, rejected_count: 0, missing_receipts: 0 },
      period: { validated: '18450', pending: '4150' },
      areas: [{ id: areaId, parent_id: null, nombre: 'Oficina', ruta: ['OFICINA'], nivel: 0, seleccionable: true, budget: '2624832.88', validated: '18450', committed: '22600', available: '2606382.88', execution_percent: '0.70' }],
      weekly: [{ week: '2026-08-24', validated: '18450', pending: '4150' }],
      suppliers: [{ name: 'Concretos Toluca', amount: '18450' }], categories: [{ name: 'MATERIAL', amount: '18450' }],
      incomes: { total: '170000.0050', reconciled: '120000.0050', pending: '50000.0000', count: 2 },
      by_item: [
        { id: secondExpensePartidaId, name: 'ALBANILERIA', validated: '12000', committed: '14000', pending: '2000', expense_count: 3, share_percent: '65.04',
          categories: [spend('MATERIAL', '9000', '2000', 2), spend('MANO DE OBRA', '3000', '0', 1)],
          subitems: [
            { ...spend('FIRMES Y HORMIGONES', '9000', '2000', 2), categories: [spend('MATERIAL', '9000', '2000', 2)] },
            { ...spend('MUROS', '3000', '0', 1), categories: [spend('MANO DE OBRA', '3000', '0', 1)] },
          ] },
        { id: expensePartidaId, name: 'PRELIMINARES', validated: '6450', committed: '8600', pending: '2150', expense_count: 2, share_percent: '34.96',
          categories: [spend('MATERIAL', '6450', '2150', 2)],
          subitems: [{ ...spend('LIMPIEZA', '6450', '2150', 2), categories: [spend('MATERIAL', '6450', '2150', 2)] }] },
      ],
      by_provider: [
        { id: supplierId, ...spend('Concretos Toluca', '14450', '4150', 4), share_percent: '78.32' },
        { id: 'f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0', ...spend('Aceros del Centro', '4000', '0', 1), share_percent: '21.68' },
      ],
      by_category: [
        { ...spend('MATERIAL', '15450', '4150', 4), id: expenseCategoryId, share_percent: '83.74' },
        { ...spend('MANO DE OBRA', '3000', '0', 1), id: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', share_percent: '16.26' },
        { ...spend('EQUIPO/HERR', '0', '0', 0), id: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3' },
      ],
    } });
  });
  await page.route(`**/api/v1/works/${workId}/expenses**`, async (route) => {
    await route.fulfill({ json: { items: [{ id: '44444444-4444-4444-8444-444444444444', area_id: areaId, expense_item_id: expensePartidaId, expense_subitem_id: expenseSubpartidaId, expense_category_id: expenseCategoryId, supplier_id: 'abababab-abab-4bab-8bab-abababababab', proveedor: 'Concretos Toluca', budget_item_id: budgetItemId, fecha: '2026-08-28', concepto: 'Cemento y adhesivo', folio: 'G-00001', folio_proveedor: 'A-1', importe: '4150', comprobante_path: 'receipt.pdf', estado: 'pendiente', area: 'Oficina', area_ruta: ['OFICINA'], partida: 'PRELIMINARES', subpartida: 'LIMPIEZA', categoria: 'MATERIAL', autor: 'Sergio Gómez', motivo_revision: null, creado_por: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expense_locked: false, can_edit: true, can_cancel: true, can_resubmit: false }], total: 1, page: 1, page_size: 50 } });
  });
  await page.route(`**/api/v1/works/${workId}/weekly-closes`, async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/v1/expenses/44444444-4444-4444-8444-444444444444', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({ json: {
      id: '44444444-4444-4444-8444-444444444444', folio: 'G-00001', supplier_folio: 'A-1', work_id: workId,
      spent_on: '2026-08-28', concept: 'Cemento y adhesivo', subtotal: '3577.5900', iva: '572.4100',
      amount: '4150.0000', iva_breakdown: true, state: 'pendiente',
      supplier_name: 'Concretos Toluca', area_path: ['OFICINA', 'PISOS'], expense_item: 'PRELIMINARES',
      expense_subitem: 'LIMPIEZA', expense_category: 'MATERIAL', budget_item: 'ALB-05 · Firme de concreto',
      author: 'Sergio Gómez', created_at: '2026-08-28T18:30:00Z', review_reason: null,
      lines: [{ position: 1, quantity: '10.0000', unit: 'bulto', description: 'Cemento', unit_price: '415.0000', discount: '0.0000', amount: '4150.0000' }],
      receipts: [{ id: 'aaaa0000-0000-4000-8000-000000000001', path: `${workId}/44444444-4444-4444-8444-444444444444/receipt.pdf`, kind: 'pdf', created_at: '2026-08-28T12:00:00Z' }],
    } });
  });
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    await route.fulfill({ json: workCatalog() });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    const payload = route.request().postDataJSON();
    // Cambio 8: the NEODATA link is optional and never preselected.
    expect(payload).toMatchObject({
      work_id: workId,
      area_id: null,
      budget_item_id: null,
      expense_item_id: secondExpensePartidaId,
      expense_subitem_id: secondExpenseSubpartidaId,
      expense_category_id: expenseCategoryId,
      supplier_id: supplierId,
    });
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await page.route('**/api/v1/weekly-closes', async (route) => {
    await route.fulfill({ status: 201, json: { expense_count: 12 } });
  });
  await page.route('**/api/v1/supplier-specialties**', async (route) => {
    await route.fulfill({ json: [{ id: specialtyId, nombre: 'Albañilería', activo: true, supplier_count: 1 }] });
  });
  await page.route('**/api/v1/suppliers/analytics', async (route) => {
    await route.fulfill({ json: { summary: { active_suppliers: 1, archived_suppliers: 0, evaluations: 1, average_rating: '4.60' }, specialties: [], permissions: { can_view_financials: true } } });
  });
  await page.route(new RegExp(`/api/v1/suppliers/${supplierId}$`), async (route) => {
    await route.fulfill({ json: {
      id: supplierId, nombre: 'Concretos Toluca', razon_social: 'Concretos del Valle SA de CV',
      rfc: 'CVA010203AB1', contacto: 'Ana Torres', telefono: '7221234567',
      whatsapp: '527221234567', email: 'ana@concretos.example', direccion: 'Toluca',
      cobertura: 'Valle de Toluca', notas: 'Entrega con revolvedora', activo: true,
      specialties: [{ id: specialtyId, nombre: 'Albañilería' }], evaluation_count: 1,
      rating: '4.60', quality: '5', timeliness: '4', value: '4', communication: '5',
      safety: '5', work_count: 1, expense_count: 1, validated_spend: '18450',
      assignments: [{ id: 'edededed-eded-4ded-8ded-edededededed', obra_id: workId, obra: 'Infra Toluca', notas: null, activo: true }],
      evaluations: [{ id: 'efefefef-efef-4fef-8fef-efefefefefef', obra_id: workId, obra_nombre: 'Infra Toluca', gasto_id: null, gasto_concepto: null, trabajo: 'Suministro de concreto', fecha_servicio: '2026-08-28', calidad: 5, cumplimiento: 4, costo_valor: 4, comunicacion: 5, seguridad_orden: 5, calificacion: '4.60', comentario: 'Entrega puntual', vigente: true, autor: 'Administrador', motivo_anulacion: null }],
      expenses: [{ id: '44444444-4444-4444-8444-444444444444', obra_id: workId, obra: 'Infra Toluca', fecha: '2026-08-28', concepto: 'Cemento y adhesivo', folio: 'G-00001', folio_proveedor: 'A-1', importe: '18450', estado: 'validado' }],
      permissions: { can_manage: true },
    } });
  });
  await page.route('**/api/v1/suppliers?**', async (route) => {
    await route.fulfill({ json: { items: [{ id: supplierId, nombre: 'Concretos Toluca', razon_social: 'Concretos del Valle SA de CV', contacto: 'Ana Torres', telefono: '7221234567', whatsapp: '527221234567', email: 'ana@concretos.example', cobertura: 'Valle de Toluca', activo: true, specialties: [{ id: specialtyId, nombre: 'Albañilería' }], rating: '4.60', evaluation_count: 1, work_count: 1 }], total: 1, page: 1, page_size: 25, permissions: { can_manage: true } } });
  });
  await page.route('**/api/v1/neodata/preview', async (route) => {
    await route.fulfill({
      json: {
        id: importId,
        obra_id: '66666666-6666-4666-8666-666666666666',
        estado: 'preview',
        duplicate: false,
        read_only: false,
        work: { id: '66666666-6666-4666-8666-666666666666', nombre: 'Casa PSE' },
        preview: previewData,
      },
    });
  });
  await page.route('**/api/v1/neodata/imports/*/preview', async (route) => {
    await route.fulfill({ json: { id: importId, estado: 'preview', preview: previewData } });
  });
});

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@d89.mx');
  await page.getByLabel('Contraseña').fill('prueba-segura');
  await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
  await expect(page.getByRole('heading', { name: 'Panorama de obra' })).toBeVisible();
}

test('login de administrador', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Control claro/i })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill('admin@d89.mx');
  await page.getByLabel('Contraseña').fill('prueba-segura');
  await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
  await expect(page.getByRole('heading', { name: 'Panorama de obra' })).toBeVisible();
});

test('recuperación de contraseña solicita un enlace por correo', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@d89.mx');
  await page.getByRole('button', { name: '¿Olvidaste tu contraseña?' }).click();
  await expect(page.getByRole('status')).toContainText('recibirás un enlace');
});

test('cerrar sesión elimina la sesión y regresa al ingreso', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: /Control claro/i })).toBeVisible();
});

test('enlace de recuperación permite guardar una contraseña nueva', async ({ page }) => {
  await page.goto('/restablecer-contrasena#access_token=e2e-access-token&refresh_token=e2e-refresh-token&expires_in=3600&token_type=bearer&type=recovery');
  await expect(page.getByRole('heading', { name: 'Nueva contraseña' })).toBeVisible();
  await page.getByLabel('Contraseña nueva').fill('Nueva-clave-segura-2026');
  await page.getByLabel('Confirmar contraseña').fill('Nueva-clave-segura-2026');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('status')).toContainText('Contraseña actualizada');
});

test('portal admin prepara preview NEODATA sin confirmar', async ({ page }) => {
  await login(page);
  await page.goto('/admin/importar');
  await expect(page.getByRole('heading', { name: 'Importar presupuesto' })).toBeVisible();
  await expect(page.getByText('Sin escritura todavía.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generar preview' })).toBeDisabled();

  await page.getByRole('button', { name: 'Nueva obra' }).click();
  await page.getByLabel('Nombre de la obra').fill('Casa PSE');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'presupuesto-casa-pse.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('fixture-e2e'),
  });
  await page.getByRole('button', { name: 'Generar preview' }).click();

  await expect(page.getByRole('status')).toContainText('Casa PSE');
  await expect(page.getByRole('heading', { name: 'Preview editable' })).toBeVisible();
  await expect(page.getByLabel('code fila 20')).toHaveValue('PRE-01');
  await page.getByLabel('description fila 20').fill('Trazo corregido');
  await page.getByRole('button', { name: /Guardar 1 corrección/ }).click();
  await expect(page.getByRole('status')).toContainText('1 corrección');
});

/** MIME of the file part inside storage-js' multipart body (what Storage validates). */
function uploadedPartType(body: Buffer | null): string | undefined {
  return /content-type:\s*([^\r\n;]+)/i.exec(body?.toString('latin1') || '')?.[1];
}

type LineInput = { quantity?: string; unit?: string; description: string; price: string; discount?: string; taxable?: boolean };

/** Fill the multi-concept editor; adds rows as needed. */
/** The supplier starts at "Seleccionar proveedor": capture requires an explicit choice. */
async function chooseSupplier(form: Locator) {
  await form.getByLabel('Proveedor', { exact: true }).selectOption(supplierId);
}

/** Partida, categoría and proveedor all start empty; a single subpartida is auto-chosen. */
async function chooseClassification(form: Locator, partida = secondExpensePartidaId) {
  await form.getByLabel('Partida', { exact: true }).selectOption(partida);
  await form.getByLabel('Categoría', { exact: true }).selectOption(expenseCategoryId);
  await chooseSupplier(form);
}

async function fillLines(form: Locator, lines: LineInput[]) {
  for (const [index, line] of lines.entries()) {
    const n = index + 1;
    if (index > 0) await form.getByRole('button', { name: '+ Agregar concepto' }).click();
    await form.getByLabel(`Cantidad concepto ${n}`).fill(line.quantity ?? '1');
    await form.getByLabel(`Unidad concepto ${n}`).fill(line.unit ?? 'pieza');
    await form.getByLabel(`Descripción concepto ${n}`).fill(line.description);
    await form.getByLabel(`Precio unitario concepto ${n}`).fill(line.price);
    if (line.discount) await form.getByLabel(`Descuento concepto ${n}`).fill(line.discount);
    if (line.taxable === false) await form.getByLabel(`IVA concepto ${n}`).uncheck();
  }
}

test('/gastos: multi-concepto con totales en vivo, exentos y varios comprobantes sin duplicar el gasto', async ({ page }) => {
  const expenseId = '44444444-4444-4444-8444-444444444444';
  const payloads: Record<string, unknown>[] = [];
  const uploads: { path: string; type: string | undefined }[] = [];
  let links = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: expenseId } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push({ path: decodeURIComponent(new URL(route.request().url()).pathname), type: uploadedPartType(route.request().postDataBuffer()) });
    if (uploads.length === 1) await route.fulfill({ status: 500, json: { message: 'Fallo simulado de subida' } });
    else await route.fulfill({ json: { Key: 'ok' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
    links += 1;
    await route.fulfill({ json: { id: expenseId } });
  });

  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  // Classification first; NEODATA is an optional, collapsed block.
  await expect(form.getByRole('button', { name: /Vincular a NEODATA \(Opcional\)/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(form.getByTestId('neodata-summary')).toHaveText('Sin área específica');
  await expect(form.getByLabel('Buscar área NEODATA')).toHaveCount(0);
  await expect(form.getByLabel('Proveedor', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Partida', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Categoría', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Subpartida', { exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: /Guardar pendiente/ })).toBeDisabled();
  await chooseClassification(form);
  await form.getByLabel('Partida', { exact: true }).selectOption(secondExpensePartidaId);
  await expect(form.getByLabel('Subpartida', { exact: true })).toHaveValue(secondExpenseSubpartidaId);
  await fillLines(form, [
    { quantity: '10', unit: 'bulto', description: 'Cemento gris 50 kg', price: '100' },
    { unit: 'servicio', description: 'Flete', price: '250.50', discount: '0.50' },
    { description: 'Concepto que se quitará', price: '999' },
    { description: 'Libro técnico', price: '100', taxable: false },
  ]);
  await form.getByLabel('Quitar concepto 3').click();
  await expect(form.getByLabel('Descripción concepto 3')).toHaveValue('Libro técnico');
  // 1000 + 250 + 100 = 1350; IVA only on the taxable 1250 (16 % incluido) = 172.41.
  await expect(form.getByTestId('line-amount-2')).toContainText('$250.00');
  await expect(form.getByTestId('expense-total')).toHaveText('$1,350.00');
  await expect(form.getByTestId('expense-iva')).toHaveText('$172.41');
  await expect(form.getByTestId('expense-subtotal')).toHaveText('$1,177.59');
  await form.getByLabel('Folio del proveedor').fill('F-889');
  await form.getByLabel('Concepto general').fill('Material y flete para firme de oficina');
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles([
    { name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') },
    { name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('png') },
  ]);
  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(form.getByRole('alert')).toContainText('Reintenta sólo los comprobantes pendientes');
  await form.getByRole('button', { name: 'Reintentar comprobantes (1)' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({
    work_id: workId, expense_item_id: secondExpensePartidaId, supplier_folio: 'F-889', iva: '172.41',
    concept: 'Material y flete para firme de oficina',
    lines: [
      { quantity: '10', unit: 'bulto', description: 'Cemento gris 50 kg', unit_price: '100', discount: '0' },
      { quantity: '1', unit: 'servicio', description: 'Flete', unit_price: '250.50', discount: '0.50' },
      { quantity: '1', unit: 'pieza', description: 'Libro técnico', unit_price: '100', discount: '0' },
    ],
  });
  expect(payloads[0]).not.toHaveProperty('amount');
  expect(payloads[0]).not.toHaveProperty('state');
  // 2 files; the PDF upload failed once. A failed file does not block the others (the
  // image still uploads), and the retry re-uploads only the PDF: 3 uploads, 2 links.
  expect(uploads).toHaveLength(3);
  expect(uploads.map((upload) => upload.type)).toEqual(['application/pdf', 'image/png', 'application/pdf']);
  expect(links).toBe(2);
  await expect(form.getByLabel('Descripción concepto 1')).toBeEmpty();
  await expect(form.getByTestId('expense-total')).toHaveText('$0.00');
});

for (const failure of ['upload', 'link'] as const) {
  test(`gasto: reintentar ${failure} no duplica el alta y bloquea envíos simultáneos`, async ({ page }) => {
    const expenseId = '44444444-4444-4444-8444-444444444444';
    let creations = 0;
    let uploads = 0;
    let links = 0;
    const linkedPaths: string[] = [];
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
    await page.route('**/api/v1/expenses', async (route) => {
      expect(route.request().method()).toBe('POST');
      creations += 1;
      await creationGate;
      await route.fulfill({ status: 201, json: { id: expenseId } });
    });
    await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
      uploads += 1;
      if (failure === 'upload' && uploads === 1) {
        await route.fulfill({ status: 500, json: { message: 'Fallo simulado de subida' } });
      } else {
        await route.fulfill({ json: { Key: 'comprobantes/receipt.png' } });
      }
    });
    await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
      expect(route.request().method()).toBe('PATCH');
      links += 1;
      linkedPaths.push(route.request().postDataJSON().path);
      if (failure === 'link' && links === 1) {
        await route.fulfill({ status: 500, json: { detail: 'Fallo simulado de vinculación' } });
      } else {
        await route.fulfill({ json: { id: expenseId } });
      }
    });
    await login(page);
    await page.goto(`/obras/${workId}/gastos`);
    await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
    const form = page.locator('form.work-expense-form');
    await chooseClassification(form);
    await fillLines(form, [{ description: 'Material único', price: '321.00' }]);
    await form.getByLabel('Concepto general').fill('Gasto que sólo debe crearse una vez');
    await form.getByLabel('Comprobantes', { exact: true }).setInputFiles({
      name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('test-image'),
    });
    try {
      // Two submits in the same JS turn test the synchronous guard, before re-render.
      await form.evaluate((element) => {
        element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await expect.poll(() => creations).toBe(1);
      await expect(form.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
      await expect(form.getByRole('button', { name: 'Cancelar', exact: true })).toBeDisabled();
      await expect(form.getByLabel('Precio unitario concepto 1')).toBeDisabled();
      await expect(form.getByLabel('Comprobantes', { exact: true })).toBeDisabled();
    } finally {
      releaseCreation();
    }
    await expect(form.getByRole('alert')).toContainText('El gasto ya está guardado');
    await expect(form.getByRole('alert')).toContainText('Reintenta sólo los comprobantes pendientes');
    // Header and concepts are frozen (already saved) but keep their values.
    await expect(form.getByLabel('Precio unitario concepto 1')).toHaveValue('321.00');
    await expect(form.getByLabel('Precio unitario concepto 1')).toBeDisabled();
    await expect(form.getByLabel('Concepto general')).toHaveValue('Gasto que sólo debe crearse una vez');
    await expect(form.getByText(failure === 'link' ? 'Error: Fallo simulado de vinculación' : 'Error: Fallo simulado de subida')).toBeVisible();
    expect(creations).toBe(1);
    await form.getByRole('button', { name: 'Reintentar comprobantes (1)' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
    expect(creations).toBe(1);
    expect(uploads).toBe(failure === 'upload' ? 2 : 1);
    expect(links).toBe(failure === 'link' ? 2 : 1);
    expect(new Set(linkedPaths).size).toBe(1);
    expect(linkedPaths[0]).toContain(`/${expenseId}/`);
    await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
    await expect(form.getByLabel('Descripción concepto 1')).toBeEmpty();
    await expect(form.getByLabel('Concepto general')).toBeEmpty();
    await chooseClassification(form);
    await fillLines(form, [{ description: 'Otro', price: '99' }]);
    await form.getByLabel('Concepto general').fill('Otro gasto intencional');
    await form.getByRole('button', { name: 'Guardar pendiente' }).click();
    await expect(form).toHaveCount(0);
    expect(creations).toBe(2);
  });
}

test('gasto: error al crear conserva datos editables para reintentar', async ({ page }) => {
  let creations = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    creations += 1;
    await route.fulfill(creations === 1
      ? { status: 503, json: { detail: 'Alta no disponible' } }
      : { status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
  const form = page.locator('form.work-expense-form');
  await chooseClassification(form);
  await fillLines(form, [{ description: 'Arena', price: '100' }]);
  await form.getByLabel('Concepto general').fill('Intento no guardado');
  await form.getByRole('button', { name: 'Guardar pendiente' }).click();
  await expect(form.getByRole('alert')).toHaveText('Alta no disponible');
  await expect(form.getByLabel('Precio unitario concepto 1')).toBeEnabled();
  await expect(form.getByLabel('Precio unitario concepto 1')).toHaveValue('100');
  await form.getByRole('button', { name: 'Guardar pendiente' }).click();
  await expect(form).toHaveCount(0);
  expect(creations).toBe(2);
});

test('gasto: renglón inválido no se envía y se explica', async ({ page }) => {
  let creations = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    creations += 1;
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await chooseClassification(form);
  await fillLines(form, [{ quantity: '2', description: 'Tubo', price: '10', discount: '25' }]);
  await form.getByLabel('Concepto general').fill('Descuento imposible');
  await expect(form.getByRole('alert')).toContainText('un descuento que no supere cantidad × precio');
  await expect(form.getByTestId('line-amount-1')).toContainText('—');
  await expect(form.getByRole('button', { name: 'Guardar pendiente' })).toBeDisabled();
  await form.getByLabel('Descuento concepto 1').fill('5');
  await expect(form.getByTestId('line-amount-1')).toContainText('$15.00');
  await expect(form.getByRole('button', { name: 'Guardar pendiente' })).toBeEnabled();
  expect(creations).toBe(0);
});

test('gasto: corregir carga los conceptos, conserva comprobantes y reintenta sin repetir la edición', async ({ page }) => {
  const expenseId = '44444444-4444-4444-8444-444444444444';
  const updates: Record<string, unknown>[] = [];
  let creations = 0;
  let uploads = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    creations += 1;
    await route.fulfill({ status: 500, json: { detail: 'No debe crear al editar' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}`, async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    expect(route.request().method()).toBe('PATCH');
    updates.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: expenseId } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads += 1;
    await route.fulfill(uploads === 1
      ? { status: 500, json: { message: 'Fallo simulado' } }
      : { json: { Key: 'comprobantes/receipt.pdf' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
    await route.fulfill({ json: { id: expenseId } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const form = page.locator('form.work-expense-form');
  await expect(form.getByRole('heading', { name: 'Corregir gasto G-00001' })).toBeVisible();
  await expect(form.getByLabel('Cantidad concepto 1')).toHaveValue('10');
  await expect(form.getByLabel('Precio unitario concepto 1')).toHaveValue('415');
  await expect(form.getByLabel('IVA concepto 1')).toBeChecked();
  await expect(form.getByLabel('Folio del proveedor')).toHaveValue('A-1');
  await expect(form.getByTestId('expense-total')).toHaveText('$4,150.00');
  await expect(form.getByText('Ya vinculado')).toBeVisible();
  await form.getByLabel('Concepto general').fill('Concepto corregido');
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles({
    name: 'cfdi-complemento.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test'),
  });
  await form.getByRole('button', { name: 'Guardar corrección' }).click();
  await expect(form.getByRole('alert')).toContainText('El gasto ya está guardado');
  await expect(form.getByLabel('Concepto general')).toHaveValue('Concepto corregido');
  await form.getByRole('button', { name: 'Reintentar comprobantes (1)' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Gasto corregido correctamente' })).toBeVisible();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    concept: 'Concepto corregido', supplier_folio: 'A-1', iva: null,
    lines: [{ quantity: '10', unit: 'bulto', description: 'Cemento', unit_price: '415', discount: '0' }],
  });
  expect(uploads).toBe(2);
  expect(creations).toBe(0);
});

function expenseForFilter(id: number, estado: 'pendiente' | 'validado' | 'rechazado') {
  return {
    id: `expense-${id}`, estado, concepto: `Material ${id}`, folio: `G-${String(id).padStart(5, '0')}`,
    folio_proveedor: `PROV-${id}`, fecha: '2026-08-28', proveedor: 'Concretos Toluca',
    importe: '100', area: 'Oficina', area_ruta: ['OFICINA'], partida: 'PRELIMINARES',
    subpartida: 'LIMPIEZA', categoria: 'MATERIAL', autor: 'Sergio Gómez',
    comprobante_path: null, motivo_revision: null, expense_locked: false,
    can_edit: false, can_cancel: false, can_resubmit: false,
  };
}

test('filtros de estado: selección instantánea, búsqueda combinada, vacío y teclado', async ({ page }) => {
  const items = [expenseForFilter(1, 'pendiente'), expenseForFilter(2, 'validado'), expenseForFilter(3, 'rechazado')];
  let calls = 0;
  await page.route(`**/api/v1/works/${workId}/expenses?**`, async (route) => {
    calls += 1;
    const params = new URL(route.request().url()).searchParams;
    expect(params.has('state')).toBe(false);
    const query = (params.get('q') || '').toLowerCase();
    const matches = items.filter((item) => [item.concepto, item.folio, item.folio_proveedor, item.proveedor].some((value) => value.toLowerCase().includes(query)));
    await route.fulfill({ json: { items: matches, total: matches.length, page: 1, page_size: 50 } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  const filters = page.getByRole('radiogroup', { name: 'Estado del gasto' });
  const rows = page.locator('.expense-table tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(filters.getByRole('radio', { name: 'Todos', exact: true })).toBeChecked();
  const initialCalls = calls;
  for (const [label, state, concept] of [
    ['Pendientes', 'pendiente', 'Material 1'], ['Validados', 'validado', 'Material 2'], ['Rechazados', 'rechazado', 'Material 3'],
  ]) {
    await filters.getByRole('radio', { name: label, exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(concept);
    await expect(rows.locator('td').nth(4)).toHaveText(state);
    await expect(filters.getByRole('radio', { checked: true })).toHaveText(label);
    await expect(page.getByRole('status')).toHaveText('1 gastos encontrados');
  }
  await filters.getByRole('radio', { name: 'Todos', exact: true }).click();
  await expect(rows).toHaveCount(3);
  expect(calls).toBe(initialCalls);

  // Clicking the active option keeps a single selected filter.
  await filters.getByRole('radio', { name: 'Todos', exact: true }).click();
  await expect(filters.getByRole('radio', { name: 'Todos', exact: true })).toBeChecked();
  await filters.getByRole('radio', { name: 'Todos', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(filters.getByRole('radio', { name: 'Pendientes', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(filters.getByRole('radio', { name: 'Pendientes', exact: true })).toBeChecked();
  await expect(rows).toHaveCount(1);

  await page.getByLabel('Buscar gastos').fill('PROV-2');
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No hay movimientos con estos filtros.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('0 gastos encontrados');
  await filters.getByRole('radio', { name: 'Validados', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Material 2');
  await expect(page.getByLabel('Buscar gastos')).toHaveValue('PROV-2');
  await filters.getByRole('radio', { name: 'Todos', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Buscar gastos').fill('');
  await expect(rows).toHaveCount(3);
});

test('filtros de estado: incluye gastos de las páginas posteriores de la API', async ({ page }) => {
  const items = [...Array.from({ length: 50 }, (_, index) => expenseForFilter(index + 1, 'pendiente')),
    expenseForFilter(51, 'validado'), expenseForFilter(52, 'rechazado')];
  const requestedPages: number[] = [];
  await page.route(`**/api/v1/works/${workId}/expenses?**`, async (route) => {
    const number = Number(new URL(route.request().url()).searchParams.get('page') || '1');
    requestedPages.push(number);
    await route.fulfill({ json: { items: items.slice((number - 1) * 50, number * 50), total: items.length, page: number, page_size: 50 } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  const filters = page.getByRole('radiogroup', { name: 'Estado del gasto' });
  const rows = page.locator('.expense-table tbody tr');
  await expect(rows).toHaveCount(52);
  expect(requestedPages).toEqual([1, 2]);
  await filters.getByRole('radio', { name: 'Validados', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Material 51');
  await filters.getByRole('radio', { name: 'Rechazados', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Material 52');
  await filters.getByRole('radio', { name: 'Pendientes', exact: true }).click();
  await expect(rows).toHaveCount(50);
  await filters.getByRole('radio', { name: 'Todos', exact: true }).click();
  await expect(rows).toHaveCount(52);
  expect(requestedPages).toEqual([1, 2]);
});

test('Ver: consulta de solo lectura del gasto con conceptos, totales y comprobantes', async ({ page }) => {
  const mutations: string[] = [];
  const signed: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.route('**/storage/v1/object/sign/comprobantes/**', async (route) => {
    signed.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ json: { signedURL: '/object/sign/comprobantes/firmado.pdf?token=temporal' } });
  });
  await page.route('**/storage/v1/object/sign/comprobantes/firmado.pdf**', async (route) => {
    await route.fulfill({ body: '%PDF-1.4', contentType: 'application/pdf' });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  const viewButton = page.getByRole('button', { name: 'Ver detalle del gasto G-00001' });
  await viewButton.click();
  const dialog = page.getByRole('dialog', { name: 'Gasto G-00001' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Consulta de gasto · sólo lectura');
  // Header
  for (const text of ['Concretos Toluca', 'A-1', '2026-08-28', 'OFICINA › PISOS', 'PRELIMINARES › LIMPIEZA › MATERIAL', 'ALB-05 · Firme de concreto', 'Sergio Gómez', 'Cemento y adhesivo']) {
    await expect(dialog).toContainText(text);
  }
  await expect(dialog.getByText('pendiente', { exact: true })).toBeVisible();
  // Concepts table and totals
  const table = dialog.getByRole('table', { name: 'Conceptos del gasto G-00001' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText('10');
  await expect(table.getByRole('row').nth(1)).toContainText('bulto');
  await expect(table.getByRole('row').nth(1)).toContainText('$415.00');
  await expect(table.getByRole('row').nth(1)).toContainText('$4,150.00');
  await expect(dialog.getByTestId('detail-subtotal')).toHaveText('$3,577.59');
  await expect(dialog.getByTestId('detail-iva')).toHaveText('$572.41');
  await expect(dialog.getByTestId('detail-total')).toHaveText('$4,150.00');
  // Strictly read-only: no form fields, no save buttons.
  await expect(dialog.locator('input, select, textarea, form')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Guardar|Editar|Cancelar gasto|Validar/ })).toHaveCount(0);
  // Receipts: view opens a signed URL in a new tab; download requests a signed URL too.
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Ver receipt.pdf' }).click();
  expect((await popup).url()).toContain('token=temporal');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Descargar receipt.pdf' }).click();
  await download;
  expect(signed).toHaveLength(2);
  expect(signed[0]).toContain(`/${workId}/44444444-4444-4444-8444-444444444444/receipt.pdf`);
  // Escape closes and focus returns to the "Ver" button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(viewButton).toBeFocused();
  expect(mutations).toEqual([]);
});

test('Ver: muestra error si el gasto no se puede cargar y se cierra con el botón', async ({ page }) => {
  await page.route('**/api/v1/expenses/44444444-4444-4444-8444-444444444444', async (route) => {
    await route.fulfill({ status: 403, json: { detail: 'Sin acceso a la obra' } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('button', { name: 'Ver detalle del gasto G-00001' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gasto' });
  await expect(dialog.getByRole('alert')).toContainText('Sin acceso a la obra');
  await dialog.getByRole('button', { name: 'Cerrar' }).click();
  await expect(dialog).toHaveCount(0);
});

const cfdiResult = {
  version: '4.0', uuid: '6F1A2B3C-4D5E-4F60-8A9B-0C1D2E3F4A5B', series: 'A', folio: '123',
  issued_at: '2026-09-20T10:00:00', currency: 'MXN', voucher_type: 'I',
  issuer: { rfc: 'NPR990101AB1', name: 'NUEVO PROVEEDOR SA DE CV', tax_regime: '601' },
  receiver_rfc: 'GOVS800101AB1',
  concepts: [
    { product_code: '30111601', quantity: '10', unit_code: 'H87', unit: null, description: 'Cemento gris', unit_value: '100', discount: '0', amount: '1000', iva: '160' },
    { product_code: '78101802', quantity: '1', unit_code: 'E48', unit: null, description: 'Flete', unit_value: '250.50', discount: '0', amount: '250.50', iva: '40.08' },
  ],
  subtotal: '1250.50', discount: '0', iva: '200.08', withholdings: '0', total: '1450.58',
  supplier: null,
  expense: {
    supplier_folio: 'A-123', concept: 'CFDI A-123 · NUEVO PROVEEDOR SA DE CV', iva: '200.08', amount: '1450.58',
    lines: [
      { quantity: '10.0000', unit: 'pieza', description: 'Cemento gris', unit_price: '116.0000', discount: '0.00' },
      { quantity: '1.0000', unit: 'servicio', description: 'Flete', unit_price: '290.5800', discount: '0.00' },
    ],
  },
  requires_review: true, warnings: ['Advertencia de ejemplo para revisión humana.'],
};

test('CFDI: el XML se lee sin IA, llena conceptos e IVA, y el emisor se da de alta sin enviar el gasto', async ({ page }) => {
  const newSupplierId = 'cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf';
  const xmlBodies: string[] = [];
  const supplierPayloads: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const uploads: { path: string; type: string | undefined }[] = [];
  await page.route('**/api/v1/expenses/extract-xml', async (route) => {
    xmlBodies.push(route.request().postDataBuffer()?.toString('latin1') || '');
    await route.fulfill({ json: cfdiResult });
  });
  await page.route('**/api/v1/suppliers', async (route) => {
    supplierPayloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: newSupplierId, nombre: 'Nuevo Proveedor', activo: true } });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    created.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push({ path: decodeURIComponent(new URL(route.request().url()).pathname), type: uploadedPartType(route.request().postDataBuffer()) });
    await route.fulfill({ json: { Key: 'ok' } });
  });
  await page.route('**/api/v1/expenses/44444444-4444-4444-8444-444444444444/receipt', async (route) => {
    await route.fulfill({ json: { id: '44444444-4444-4444-8444-444444444444' } });
  });

  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles([
    { name: 'factura.xml', mimeType: '', buffer: Buffer.from('<cfdi:Comprobante/>') },
    { name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') },
  ]);
  const summary = form.getByRole('region', { name: 'Datos del CFDI' });
  await expect(summary).toContainText('NUEVO PROVEEDOR SA DE CV');
  await expect(summary).toContainText('$1,450.58');
  await expect(summary).toContainText('Advertencia de ejemplo');
  expect(xmlBodies[0]).toContain('name="work_id"');
  await expect(summary).toContainText('no está en el directorio');

  await summary.getByRole('button', { name: 'Usar datos del CFDI' }).click();
  await expect(form.getByLabel('Descripción concepto 2')).toHaveValue('Flete');
  await expect(form.getByLabel('Precio unitario concepto 1')).toHaveValue('116');
  await expect(form.getByTestId('expense-total')).toHaveText('$1,450.58');
  await expect(form.getByTestId('expense-iva')).toHaveText('$200.08');
  await expect(form.getByText('IVA (CFDI)')).toBeVisible();
  await expect(form.getByLabel('Folio del proveedor')).toHaveValue('A-123');
  await expect(form.getByLabel('Concepto general')).toHaveValue('CFDI A-123 · NUEVO PROVEEDOR SA DE CV');
  await expect(form.getByLabel('Fecha')).toHaveValue('2026-09-20');

  // Quick supplier creation prefilled from the CFDI issuer, in a portaled modal.
  await summary.getByRole('button', { name: 'Dar de alta con los datos del CFDI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Alta de proveedor' });
  await expect(dialog.getByLabel('RFC')).toHaveValue('NPR990101AB1');
  await expect(dialog.getByLabel('Nombre comercial')).toHaveValue('NUEVO PROVEEDOR SA DE CV');
  await dialog.getByLabel('Nombre comercial').fill('Nuevo Proveedor');
  // Enter inside the modal submits the modal only, never the enclosing expense form.
  await dialog.getByLabel('Nombre comercial').press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(created).toHaveLength(0);
  expect(supplierPayloads).toHaveLength(1);
  expect(supplierPayloads[0]).toMatchObject({ name: 'Nuevo Proveedor', tax_id: 'NPR990101AB1', work_id: workId });
  await expect(form.getByLabel('Proveedor', { exact: true })).toHaveValue(newSupplierId);
  await form.getByLabel('Partida', { exact: true }).selectOption(secondExpensePartidaId);
  await form.getByLabel('Categoría', { exact: true }).selectOption(expenseCategoryId);

  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    supplier_id: newSupplierId, supplier_folio: 'A-123', iva: '200.08',
    lines: [
      { quantity: '10', unit: 'pieza', description: 'Cemento gris', unit_price: '116', discount: '0' },
      { quantity: '1', unit: 'servicio', description: 'Flete', unit_price: '290.58', discount: '0' },
    ],
  });
  // The XML is stored with an allowed MIME even if the browser reported none.
  expect(uploads.map((upload) => [upload.path.split('-').pop(), upload.type])).toEqual([
    ['factura.xml', 'application/xml'], ['factura.pdf', 'application/pdf'],
  ]);
});

test('CFDI: editar un concepto recalcula el IVA con la regla del 16 %', async ({ page }) => {
  await page.route('**/api/v1/expenses/extract-xml', async (route) => {
    await route.fulfill({ json: { ...cfdiResult, supplier: { id: supplierId, name: 'Concretos Toluca', active: true, assigned_to_work: true }, warnings: [], requires_review: false } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles({ name: 'f.xml', mimeType: 'text/xml', buffer: Buffer.from('<x/>') });
  const summary = form.getByRole('region', { name: 'Datos del CFDI' });
  await expect(summary).toContainText('Proveedor encontrado: Concretos Toluca');
  await summary.getByRole('button', { name: 'Usar datos del CFDI' }).click();
  await expect(form.getByLabel('Proveedor', { exact: true })).toHaveValue(supplierId);
  await expect(form.getByTestId('expense-iva')).toHaveText('$200.08');
  await form.getByLabel('Cantidad concepto 2').fill('2');
  await expect(form.getByText('IVA (CFDI)')).toHaveCount(0);
  // 1160 + 581.16 = 1741.16 → IVA incluido 16 % = 240.16.
  await expect(form.getByTestId('expense-total')).toHaveText('$1,741.16');
  await expect(form.getByTestId('expense-iva')).toHaveText('$240.16');
});

test('alta rápida de proveedor desde el selector y permisos de operativo', async ({ page }) => {
  const newSupplierId = 'dededede-dede-4ede-8ede-dededededede';
  let expenseCreations = 0;
  await page.route('**/api/v1/suppliers', async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ name: 'Herrería Rápida', work_id: workId });
    await route.fulfill({ status: 201, json: { id: newSupplierId, nombre: 'Herrería Rápida', activo: true } });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    expenseCreations += 1;
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  const supplier = form.getByLabel('Proveedor', { exact: true });
  await expect(supplier).toHaveValue(''); // no silent default: the choice is intentional
  await chooseSupplier(form);
  await supplier.selectOption({ label: '+ Nuevo proveedor' });
  await expect(supplier).toHaveValue(supplierId); // selection kept while the modal is open
  const dialog = page.getByRole('dialog', { name: 'Alta de proveedor' });
  await expect(dialog.getByLabel('Auto-rellenar desde Constancia (PDF)')).toBeVisible();
  await dialog.getByLabel('Nombre comercial').fill('Herrería Rápida');
  await dialog.getByRole('button', { name: 'Crear proveedor' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(supplier).toHaveValue(newSupplierId);
  await expect(supplier.locator('option', { hasText: 'Herrería Rápida' })).toHaveCount(1);
  expect(expenseCreations).toBe(0);

  // Operativo: the catalog says no supplier management, so the option is not offered.
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ json: { ...json, permissions: { can_manage_suppliers: false } } });
  });
  await page.reload();
  await expect(form.getByLabel('Proveedor', { exact: true }).locator('option', { hasText: '+ Nuevo proveedor' })).toHaveCount(0);
});

test('comprobantes: formatos no permitidos se rechazan sin agregarse', async ({ page }) => {
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles([
    { name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
    { name: 'ok.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpg') },
  ]);
  await expect(form.getByRole('alert')).toContainText('virus.exe: formato no permitido');
  await expect(form.locator('.receipt-list li')).toHaveCount(1);
  await expect(form.locator('.receipt-list')).toContainText('ok.jpg');
});

test('cierre semanal navega el historial, cierra y reabre con evidencia', async ({ page }) => {
  const closeId = '66666666-6666-4666-8666-666666666666';
  const requestedWeeks: string[] = [];
  const closes: { iso_year: number; iso_week: number }[] = [];
  const reopenReasons: string[] = [];
  let state: 'none' | 'cerrado' | 'reabierto' = 'none';
  const total = (count: number, amount: string) => ({ count, amount });
  await page.route(`**/api/v1/works/${workId}/weekly-closes/preview**`, async (route) => {
    const url = new URL(route.request().url());
    const year = Number(url.searchParams.get('iso_year'));
    const week = Number(url.searchParams.get('iso_week'));
    requestedWeeks.push(`${year}-W${week}`);
    const history = [
      ...(state !== 'none' ? [{ accion: 'cerrar_lote', creado_en: '2026-08-30T18:00:00Z', autor: 'Sergio Gómez', detalle_json: { revision: 1 } }] : []),
      ...(state === 'reabierto' ? [{ accion: 'reabrir', creado_en: '2026-08-31T18:00:00Z', autor: 'Sergio Gómez', detalle_json: { revision: 1, motivo: reopenReasons[0] } }] : []),
    ];
    await route.fulfill({
      json: {
        work_id: workId, iso_year: year, iso_week: week,
        date_from: '2026-08-24', date_to: '2026-08-30',
        summary: { count: 1, amount: '4150', pendiente: total(0, '0'), validado: total(1, '4150'), rechazado: total(0, '0') },
        expenses: [{ id: '44444444-4444-4444-8444-444444444444', fecha: '2026-08-28', concepto: 'Cemento y adhesivo', importe: '4150', estado: 'validado', origen: 'web' }],
        close: state === 'none' ? null : { id: closeId, estado: state, revision: 1 },
        revisions: state === 'none' ? [] : [{ revision: 1, expense_count: 1, amount: '4150' }],
        history,
        permissions: { can_manage: true },
      },
    });
  });
  await page.route('**/api/v1/weekly-closes', async (route) => {
    closes.push(route.request().postDataJSON());
    state = 'cerrado';
    await route.fulfill({ status: 201, json: { id: closeId, expense_count: 1, revision: 1 } });
  });
  await page.route(`**/api/v1/weekly-closes/${closeId}/reopen`, async (route) => {
    reopenReasons.push(route.request().postDataJSON().reason);
    state = 'reabierto';
    await route.fulfill({ json: { id: closeId, estado: 'reabierto', revision: 1 } });
  });

  await login(page);
  await page.goto('/cierres');
  await page.getByLabel('Semana ISO').fill('2026-W36');
  await expect(page.getByRole('heading', { name: /semana 36 \/ 2026/ })).toBeVisible();
  await page.getByRole('button', { name: 'Anterior' }).click();
  await expect(page.getByRole('heading', { name: /semana 35 \/ 2026/ })).toBeVisible();
  expect(requestedWeeks).toContain('2026-W35');

  await page.getByRole('button', { name: 'Cerrar semana 35' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cierre confirmado' })).toBeVisible();
  expect(closes).toEqual([{ work_id: workId, iso_year: 2026, iso_week: 35 }]);
  await expect(page.getByText('Cerrado', { exact: true })).toBeVisible();
  await expect(page.locator('strong', { hasText: /^Revisión 1$/ })).toBeVisible();

  const reopen = page.getByRole('button', { name: 'Reabrir semana' });
  await expect(reopen).toBeDisabled();
  await page.getByLabel('Motivo de reapertura').fill('Factura duplicada del proveedor');
  await reopen.click();
  await expect(page.getByRole('status').filter({ hasText: 'Semana reabierta' })).toBeVisible();
  expect(reopenReasons).toEqual(['Factura duplicada del proveedor']);
  await expect(page.getByText('Reapertura · revisión 1')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cerrar semana 35' })).toBeEnabled();
});

test('directorio muestra ficha, especialidad y evaluación del proveedor', async ({ page }) => {
  await login(page);
  await page.goto('/proveedores');
  await expect(page.getByRole('heading', { name: 'Directorio de proveedores' })).toBeVisible();
  await expect(page.getByText('Concretos Toluca')).toBeVisible();
  await page.getByRole('link', { name: /Concretos Toluca/ }).click();
  await expect(page.getByRole('heading', { name: 'Concretos Toluca' })).toBeVisible();
  await expect(page.getByText('Ana Torres')).toBeVisible();
  await expect(page.getByText('Suministro de concreto')).toBeVisible();
  await page.getByRole('button', { name: /Evaluar trabajo/ }).click();
  await expect(page.getByRole('heading', { name: 'Evaluar trabajo' })).toBeVisible();
  await expect(page.getByLabel('Obra')).toHaveValue(workId);
});

test('alta de proveedor se auto-rellena desde la CSF y bloquea el formulario mientras analiza', async ({ page }) => {
  let releaseExtraction!: () => void;
  const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
  const extractionRequests: { auth: string | null; contentType: string | null; body: string }[] = [];
  let created: Record<string, unknown> | undefined;
  await page.route('**/api/v1/suppliers/extract-csf', async (route) => {
    const request = route.request();
    extractionRequests.push({
      auth: await request.headerValue('authorization'),
      contentType: await request.headerValue('content-type'),
      body: request.postDataBuffer()?.toString('latin1') || '',
    });
    await extractionGate;
    await route.fulfill({ json: {
      extraction: {
        rfc: 'CTO010203AB1', razon_social: 'Concretos Toluca SA de CV',
        regimen_fiscal: '601 - General de Ley Personas Morales', codigo_postal: '50000',
        requiere_validacion_humana: false, motivos_revision: [],
      },
      model: 'gemini-3.5-flash-lite', tool_call_log_id: 'abababab-0000-4000-8000-000000000001',
    } });
  });
  await page.route('**/api/v1/suppliers', async (route) => {
    created = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { id: supplierId, nombre: 'Concretos', activo: true } });
  });

  await login(page);
  await page.goto('/proveedores');
  await page.getByRole('button', { name: /Nuevo proveedor/ }).click();
  const dialog = page.locator('form.supplier-dialog');
  await dialog.getByLabel('Nombre comercial').fill('Concretos');
  await dialog.getByLabel('Persona de contacto').fill('Ana Torres');
  const upload = dialog.getByLabel('Auto-rellenar desde Constancia (PDF)');
  await expect(upload).toHaveAttribute('accept', '.pdf,application/pdf');
  try {
    await upload.setInputFiles({ name: 'csf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7 csf') });
    await expect(dialog.getByText('Analizando documento con IA…').first()).toBeVisible();
    await expect(dialog.getByLabel('RFC')).toBeDisabled();
    await expect(dialog.getByLabel('Nombre comercial')).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Analizando documento con IA…' })).toBeDisabled();
  } finally {
    releaseExtraction();
  }
  await expect(dialog.getByRole('status').filter({ hasText: 'Datos cargados desde la constancia' })).toBeVisible();
  await expect(dialog.getByLabel('Razón social')).toHaveValue('Concretos Toluca SA de CV');
  await expect(dialog.getByLabel('RFC')).toHaveValue('CTO010203AB1');
  await expect(dialog.getByLabel('Régimen fiscal')).toHaveValue('601 - General de Ley Personas Morales');
  await expect(dialog.getByLabel('Código postal fiscal')).toHaveValue('50000');
  // Fields the user typed before the extraction are preserved.
  await expect(dialog.getByLabel('Nombre comercial')).toHaveValue('Concretos');
  await expect(dialog.getByLabel('Persona de contacto')).toHaveValue('Ana Torres');
  expect(extractionRequests).toHaveLength(1);
  expect(extractionRequests[0].auth).toMatch(/^Bearer /);
  expect(extractionRequests[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
  expect(extractionRequests[0].body).toContain('name="file"; filename="csf.pdf"');

  await dialog.getByRole('button', { name: 'Crear proveedor' }).click();
  await expect(dialog).toHaveCount(0);
  expect(created).toMatchObject({
    name: 'Concretos', legal_name: 'Concretos Toluca SA de CV', tax_id: 'CTO010203AB1',
    tax_regime: '601 - General de Ley Personas Morales', postal_code: '50000', contact_name: 'Ana Torres',
  });
});

for (const [status, text] of [
  [503, 'El servicio de IA no está disponible'],
  [429, 'Se agotó el presupuesto mensual de IA'],
  [502, 'La IA no pudo leer la constancia'],
] as const) {
  test(`CSF: error ${status} muestra aviso y permite captura manual`, async ({ page }) => {
    await page.route('**/api/v1/suppliers/extract-csf', async (route) => {
      await route.fulfill({ status, json: { detail: 'detalle técnico' } });
    });
    await login(page);
    await page.goto('/proveedores');
    await page.getByRole('button', { name: /Nuevo proveedor/ }).click();
    const dialog = page.locator('form.supplier-dialog');
    await dialog.getByLabel('Auto-rellenar desde Constancia (PDF)').setInputFiles({
      name: 'csf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7'),
    });
    const alert = dialog.getByRole('alert');
    await expect(alert).toContainText(text);
    await expect(alert).toContainText('Puedes capturar los datos manualmente');
    await expect(dialog.getByLabel('RFC')).toBeEnabled();
    await dialog.getByLabel('RFC').fill('CTO010203AB1');
    await expect(dialog.getByRole('button', { name: 'Crear proveedor' })).toBeEnabled();
  });
}

test('CSF: un archivo que no es PDF se rechaza sin llamar a la API', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/suppliers/extract-csf', async (route) => {
    calls += 1;
    await route.fulfill({ status: 500, json: {} });
  });
  await login(page);
  await page.goto('/proveedores');
  await page.getByRole('button', { name: /Nuevo proveedor/ }).click();
  const dialog = page.locator('form.supplier-dialog');
  await dialog.getByLabel('Auto-rellenar desde Constancia (PDF)').setInputFiles({
    name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from('png'),
  });
  await expect(dialog.getByRole('alert')).toContainText('El archivo no es un PDF válido');
  expect(calls).toBe(0);
});

test('CSF: una extracción dudosa avisa qué revisar', async ({ page }) => {
  await page.route('**/api/v1/suppliers/extract-csf', async (route) => {
    await route.fulfill({ json: {
      extraction: {
        rfc: 'CTO010203AB1', razon_social: null, regimen_fiscal: null, codigo_postal: '50000',
        requiere_validacion_humana: true, motivos_revision: ['No se pudo leer el campo razon_social.'],
      },
      model: 'gemini-3.5-flash-lite', tool_call_log_id: 'abababab-0000-4000-8000-000000000002',
    } });
  });
  await login(page);
  await page.goto('/proveedores');
  await page.getByRole('button', { name: /Nuevo proveedor/ }).click();
  const dialog = page.locator('form.supplier-dialog');
  await dialog.getByLabel('Razón social').fill('Capturada a mano');
  await dialog.getByLabel('Auto-rellenar desde Constancia (PDF)').setInputFiles({
    name: 'csf.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7'),
  });
  await expect(dialog.getByRole('status').filter({ hasText: 'Revisa y corrige' })).toContainText('razon_social');
  await expect(dialog.getByLabel('RFC')).toHaveValue('CTO010203AB1');
  // A null from the AI never erases what the user already captured.
  await expect(dialog.getByLabel('Razón social')).toHaveValue('Capturada a mano');
});

test('editar proveedor conserva régimen fiscal y código postal', async ({ page }) => {
  let patched: Record<string, unknown> | undefined;
  await page.route(new RegExp(`/api/v1/suppliers/${supplierId}$`), async (route) => {
    if (route.request().method() === 'PATCH') {
      patched = route.request().postDataJSON();
      await route.fulfill({ json: { id: supplierId } });
    } else {
      await route.fallback();
    }
  });
  await login(page);
  await page.goto(`/proveedores/${supplierId}`);
  await page.getByRole('button', { name: /Editar/ }).first().click();
  const dialog = page.locator('form.supplier-dialog');
  await expect(dialog.getByLabel('Auto-rellenar desde Constancia (PDF)')).toHaveCount(0);
  await dialog.getByLabel('Régimen fiscal').fill('626 - RESICO');
  await dialog.getByLabel('Código postal fiscal').fill('50100');
  await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect.poll(() => patched).toMatchObject({ tax_regime: '626 - RESICO', postal_code: '50100', tax_id: 'CVA010203AB1' });
});

test('Jev: foto del ticket, corrección conversacional y guardado con el ticket vinculado', async ({ page }) => {
  const expenseId = '45454545-4545-4545-8545-454545454545';
  let releaseExtraction!: () => void;
  const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
  let releaseJev!: () => void;
  const jevGate = new Promise<void>((resolve) => { releaseJev = resolve; });
  const jevBodies: { extraction: { conceptos: { descripcion: string }[] }; instruction: string }[] = [];
  const created: Record<string, unknown>[] = [];
  const uploads: string[] = [];
  const links: string[] = [];
  const line = (cantidad: string, precio: string, descripcion: string) => ({ cantidad, precio_unitario: precio, descripcion });
  await page.route('**/api/v1/expenses/extract-receipt', async (route) => {
    await extractionGate;
    await route.fulfill({ json: {
      extraction: {
        total_detectado: '1250.5000', suma_conceptos: '1100.00', requiere_validacion_humana: true,
        conceptos: [line('10.0000', '100.0000', 'Cemento gris 50 kg'), line('1.0000', '100.0000', 'Cemento blanco')],
        motivos_revision: ['La suma de conceptos (1100.00) no coincide con el total (1250.5000).'],
      },
      model: 'gemini-3.8-flash', tool_call_log_id: 'abababab-0000-4000-8000-000000000010',
    } });
  });
  await page.route('**/api/v1/expenses/jev-chat', async (route) => {
    jevBodies.push(route.request().postDataJSON());
    if (jevBodies.length === 1) await jevGate;
    await route.fulfill({ json: {
      extraction: {
        total_detectado: '1250.5000', suma_conceptos: '1250.50', requiere_validacion_humana: false,
        conceptos: [line('10.0000', '100.0000', 'Cemento gris 50 kg'), line('1.0000', '250.5000', 'Pintura vinílica')],
        motivos_revision: [],
      },
      respuesta: 'Cambié el segundo concepto a pintura vinílica de $250.50.',
      model: 'gemini-3.5-flash-lite', tool_call_log_id: 'abababab-0000-4000-8000-000000000011',
    } });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    created.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: expenseId } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ json: { Key: 'comprobantes/ticket.jpg' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
    links.push(route.request().postDataJSON().path);
    await route.fulfill({ json: { id: expenseId } });
  });

  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
  const form = page.locator('form.work-expense-form');
  await chooseClassification(form);
  const save = form.getByRole('button', { name: /Guardar pendiente/ });
  const assistant = form.getByRole('region', { name: 'Captura inteligente del ticket' });
  try {
    await assistant.getByLabel('Foto del ticket o nota de remisión').setInputFiles({
      name: 'ticket.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });
    await expect(assistant.getByText('Leyendo ticket con IA…').first()).toBeVisible();
    await expect(save).toBeDisabled();
  } finally {
    releaseExtraction();
  }
  await expect(assistant.getByRole('cell', { name: 'Cemento blanco' })).toBeVisible();
  await expect(assistant.getByText('Revisa antes de guardar.')).toBeVisible();
  await expect(assistant.getByText(/no coincide con el total/)).toBeVisible();
  await expect(form.locator('.receipt-list')).toContainText('ticket.jpg · foto del ticket');

  const chat = assistant.getByLabel('Corrección para Jev');
  await chat.fill('El segundo concepto es pintura, no cemento, y cuesta 250.50');
  try {
    await assistant.getByRole('button', { name: 'Enviar a Jev' }).click();
    await expect(assistant.getByRole('button', { name: 'Jev está revisando…' })).toBeDisabled();
    await expect(chat).toBeDisabled();
    await expect(save).toBeDisabled();
  } finally {
    releaseJev();
  }
  await expect(assistant.getByRole('cell', { name: 'Pintura vinílica' })).toBeVisible();
  await expect(assistant.getByRole('cell', { name: 'Cemento blanco' })).toHaveCount(0);
  await expect(assistant.getByText('La suma de conceptos coincide con el total.')).toBeVisible();
  await expect(assistant.getByText('Cambié el segundo concepto a pintura vinílica de $250.50.')).toBeVisible();
  expect(jevBodies[0].instruction).toBe('El segundo concepto es pintura, no cemento, y cuesta 250.50');
  expect(jevBodies[0].extraction.conceptos[1].descripcion).toBe('Cemento blanco');
  await expect(chat).toBeEnabled();
  // No concepts yet: saving waits until the user applies (or types) valid lines.
  await expect(save).toBeDisabled();

  await assistant.getByRole('button', { name: 'Usar en el formulario' }).click();
  await expect(form.getByLabel('Cantidad concepto 1')).toHaveValue('10');
  await expect(form.getByLabel('Descripción concepto 2')).toHaveValue('Pintura vinílica');
  await expect(form.getByLabel('Precio unitario concepto 2')).toHaveValue('250.5');
  await expect(form.getByTestId('expense-total')).toHaveText('$1,250.50');
  await expect(form.getByLabel('Concepto general')).toHaveValue('10 × Cemento gris 50 kg; 1 × Pintura vinílica');
  await expect(save).toBeEnabled();
  // Manual fallback: the regular fields stay editable after applying Jev's result.
  await form.getByLabel('Concepto general').fill('Cemento y pintura para oficina');
  // With a complete, valid form, Enter in the chat must never submit the expense: neither
  // when the text is too short to reach Jev (nothing gets disabled) nor when it is sent.
  await chat.fill('x');
  await chat.press('Enter');
  await expect(chat).toHaveValue('x');
  expect(created).toHaveLength(0);
  expect(jevBodies).toHaveLength(1);
  await chat.fill('Confirma el total');
  await chat.press('Enter');
  await expect.poll(() => jevBodies.length).toBe(2);
  expect(jevBodies[1].extraction.conceptos[1].descripcion).toBe('Pintura vinílica');
  await expect(assistant.getByText('Cambié el segundo concepto', { exact: false })).toHaveCount(2);
  expect(created).toHaveLength(0);
  // A new Jev answer does not overwrite what the user typed in the form.
  await expect(form.getByLabel('Concepto general')).toHaveValue('Cemento y pintura para oficina');
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    work_id: workId, concept: 'Cemento y pintura para oficina', iva: null,
    lines: [
      { quantity: '10', unit: 'pieza', description: 'Cemento gris 50 kg', unit_price: '100', discount: '0' },
      { quantity: '1', unit: 'pieza', description: 'Pintura vinílica', unit_price: '250.5', discount: '0' },
    ],
  });
  expect(created[0]).not.toHaveProperty('state');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain(`/${workId}/${expenseId}/`);
  expect(uploads[0]).toMatch(/ticket\.jpg$/);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatch(new RegExp(`^${workId}/${expenseId}/\\d+-receipt-\\d+-ticket\\.jpg$`));
});

test('Jev: si la IA está caída se captura a mano; la foto se puede quitar y se suben los comprobantes elegidos', async ({ page }) => {
  const expenseId = '46464646-4646-4646-8646-464646464646';
  const uploads: string[] = [];
  let created = 0;
  await page.route('**/api/v1/expenses/extract-receipt', async (route) => {
    await route.fulfill({ status: 503, json: { detail: 'Servicio de IA no disponible' } });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    created += 1;
    await route.fulfill({ status: 201, json: { id: expenseId } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ json: { Key: 'ok' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
    await route.fulfill({ json: { id: expenseId } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await chooseClassification(form);
  await form.getByLabel('Foto del ticket o nota de remisión').setInputFiles({
    name: 'ticket.png', mimeType: 'image/png', buffer: Buffer.from('png'),
  });
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('El servicio de IA no está disponible');
  await expect(alert).toContainText('Puedes capturar los datos manualmente');
  await expect(form.getByLabel('Corrección para Jev')).toHaveCount(0);
  await fillLines(form, [{ quantity: '2', unit: 'kg', description: 'Clavos', price: '40' }]);
  await form.getByLabel('Concepto general').fill('Clavos, capturado a mano');
  // The photo stays as a receipt even if the AI failed; the user may remove it.
  await expect(form.locator('.receipt-list')).toContainText('ticket.png · foto del ticket');
  await form.getByRole('button', { name: 'Quitar ticket.png' }).click();
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7'),
  });
  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  expect(created).toBe(1);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toMatch(/factura\.pdf$/);
});

test('Jev: un archivo que no es imagen se rechaza sin llamar a la IA', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/v1/expenses/extract-receipt', async (route) => {
    calls += 1;
    await route.fulfill({ status: 500, json: {} });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await chooseClassification(form);
  await form.getByLabel('Foto del ticket o nota de remisión').setInputFiles({
    name: 'ticket.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a'),
  });
  await expect(form.getByRole('alert')).toContainText('JPEG, PNG o WebP');
  await expect(form.locator('.receipt-list')).toHaveCount(0);
  expect(calls).toBe(0);
});

test('dashboard es usable en viewport móvil', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Solo valida el proyecto móvil');
  await login(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Navegación móvil' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Panorama de obra' })).toBeVisible();
});

test('administrador elimina una obra con confirmación por nombre', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Eliminar Infra Toluca' }).click();
  const confirmButton = page.getByRole('button', { name: 'Eliminar definitivamente' });
  await expect(page.getByRole('dialog')).toContainText('Acción irreversible');
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel('Escribe el nombre exacto para confirmar').fill('Infra');
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel('Escribe el nombre exacto para confirmar').fill('Infra Toluca');
  await confirmButton.click();
  await expect(page.getByRole('status')).toContainText('Ya puedes cargarla de cero');
  await expect(page.getByText('No hay obras asignadas a esta cuenta.')).toBeVisible();
});

test('administrador entra al espacio específico de una obra y recorre sus módulos', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Abrir' }).click();
  await expect(page).toHaveURL(new RegExp(`/obras/${workId}$`));
  await expect(page.getByRole('heading', { name: 'Infra Toluca' })).toBeVisible();
  await expect(page.getByText('Presupuesto vigente')).toBeVisible();
  const workNavigation = page.getByRole('navigation', { name: 'Secciones de la obra' });
  await workNavigation.getByRole('link', { name: 'Gastos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Movimientos de la obra' })).toBeVisible();
  await expect(page.getByText('Cemento y adhesivo')).toBeVisible();
  await page.getByRole('button', { name: 'Nuevo gasto' }).click();
  await page.getByRole('button', { name: /Vincular a NEODATA/ }).click();
  await page.getByLabel('Buscar área NEODATA').fill('oficina');
  await expect(page.getByLabel('Área NEODATA').getByRole('option', { name: 'OFICINA' })).toHaveCount(1);
  await page.locator('form').getByRole('button', { name: 'Cancelar' }).click();
  await workNavigation.getByRole('link', { name: 'Presupuesto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Árbol presupuestal NEODATA' })).toBeVisible();
  await expect(page.getByText('Oficina', { exact: true })).toBeVisible();
});

test('pestaña Cierres de la obra usa el selector ISO con el workId del espacio', async ({ page }) => {
  const previewPaths: string[] = [];
  const closes: unknown[] = [];
  let expenseLoads = 0;
  let closed = false;
  await page.route(`**/api/v1/works/${workId}/expenses**`, async (route) => {
    expenseLoads += 1;
    await route.fulfill({ json: { items: [], total: 0, page: 1, page_size: 50 } });
  });
  await page.route('**/api/v1/works/*/weekly-closes/preview**', async (route) => {
    const url = new URL(route.request().url());
    previewPaths.push(`${url.pathname}?${url.searchParams}`);
    const week = Number(url.searchParams.get('iso_week'));
    const total = { count: 0, amount: '0' };
    await route.fulfill({
      json: {
        work_id: workId, iso_year: 2026, iso_week: week, date_from: '2026-08-24', date_to: '2026-08-30',
        summary: { count: 0, amount: '0', pendiente: total, validado: total, rechazado: total },
        expenses: [], history: [],
        close: closed ? { id: '66666666-6666-4666-8666-666666666666', estado: 'cerrado', revision: 1 } : null,
        revisions: [], permissions: { can_manage: true },
      },
    });
  });
  await page.route('**/api/v1/weekly-closes', async (route) => {
    closes.push(route.request().postDataJSON());
    closed = true;
    await route.fulfill({ status: 201, json: { expense_count: 0 } });
  });

  await login(page);
  await page.goto(`/obras/${workId}/cierres`);
  await expect(page.getByLabel('Semana ISO')).toBeVisible();
  // Exact match: 'Secciones de la obra' (workspace nav) must not count as a work selector.
  await expect(page.getByLabel('Obra', { exact: true })).toHaveCount(0);
  await page.getByLabel('Semana ISO').fill('2026-W36');
  await page.getByRole('button', { name: 'Anterior' }).click();
  await expect(page.getByRole('heading', { name: /^semana 35 \/ 2026$/ })).toBeVisible();
  expect(previewPaths).toContain(`/api/v1/works/${workId}/weekly-closes/preview?iso_year=2026&iso_week=35`);
  expect(previewPaths.every((path) => path.startsWith(`/api/v1/works/${workId}/`))).toBe(true);

  const loadsBeforeClose = expenseLoads;
  await page.getByRole('button', { name: 'Cerrar semana 35' }).click();
  await expect(page.getByText('Cerrado', { exact: true })).toBeVisible();
  expect(closes).toEqual([{ work_id: workId, iso_year: 2026, iso_week: 35 }]);
  await expect.poll(() => expenseLoads).toBeGreaterThan(loadsBeforeClose);
});

test('administrador adjunta un comprobante faltante desde validación', async ({ page }) => {
  let receiptAttached = false;
  await page.route(`**/api/v1/works/${workId}/expenses**`, async (route) => {
    await route.fulfill({ json: { items: [{
      id: '44444444-4444-4444-8444-444444444444', area_id: areaId,
      expense_item_id: expensePartidaId, expense_subitem_id: expenseSubpartidaId,
      expense_category_id: expenseCategoryId, supplier_id: null,
      proveedor: 'Concretos Toluca', budget_item_id: budgetItemId,
      fecha: '2026-08-28', concepto: 'Cemento sin comprobante', folio: 'A-2',
      importe: '4150', comprobante_path: receiptAttached ? 'evidence.pdf' : null,
      estado: 'pendiente', area: 'Oficina', area_ruta: ['OFICINA'],
      partida: 'PRELIMINARES', subpartida: 'LIMPIEZA', categoria: 'MATERIAL',
      autor: 'Administrador D89', motivo_revision: null,
      creado_por: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expense_locked: false,
      can_edit: true, can_cancel: true, can_resubmit: false,
    }], total: 1, page: 1, page_size: 50 } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    await route.fulfill({ status: 200, json: { Key: 'evidence.pdf' } });
  });
  await page.route('**/api/v1/expenses/44444444-4444-4444-8444-444444444444/receipt', async (route) => {
    expect(route.request().method()).toBe('PATCH');
    receiptAttached = true;
    await route.fulfill({ json: { id: '44444444-4444-4444-8444-444444444444', comprobante_path: 'evidence.pdf' } });
  });

  await login(page);
  await page.goto(`/obras/${workId}/validacion`);
  await expect(page.getByText('Faltante', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validar', exact: true })).toBeDisabled();
  await page.getByLabel('Adjuntar comprobante').setInputFiles({
    name: 'evidence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test'),
  });
  await expect(page.getByRole('status')).toContainText('ya puede validarse');
  await expect(page.getByRole('button', { name: 'Ver archivo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Validar', exact: true })).toBeEnabled();
});

// --- Ingresos ------------------------------------------------------------------------

const incomeRows = [
  {
    id: '71717171-7171-4171-8171-717171717171', work_id: workId, folio: 'I-00002', received_on: '2026-09-20',
    concept: 'Estimación 1', amount: '120000.0050', state: 'conciliado', created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_at: '2026-09-20T12:00:00Z', reconciled_at: '2026-09-21T15:30:00Z', reconciled_by: 'Sergio Gómez', reversal_reason: null,
    receipts: [{ id: '72727272-7272-4272-8272-727272727272', path: `${workId}/71717171-7171-4171-8171-717171717171/1759000000000-income-receipt-1-transferencia.pdf`, kind: 'pdf', created_at: '2026-09-20T12:01:00Z' }],
  },
  {
    id: '73737373-7373-4373-8373-737373737373', work_id: workId, folio: 'I-00001', received_on: '2026-09-01',
    concept: 'Anticipo', amount: '50000.0000', state: 'pendiente', created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_at: '2026-09-01T12:00:00Z', receipts: [],
  },
];

test('Ingresos: pestaña con listado, totales y comprobantes para ver o descargar', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => {
    await route.fulfill({ json: incomeRows });
  });
  const signed: string[] = [];
  await page.route('**/storage/v1/object/sign/comprobantes/**', async (route) => {
    signed.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ json: { signedURL: '/object/sign/comprobantes/firmado.pdf?token=ingreso' } });
  });
  await page.route('**/storage/v1/object/sign/comprobantes/firmado.pdf**', async (route) => {
    await route.fulfill({ body: '%PDF-1.4', contentType: 'application/pdf' });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('navigation', { name: 'Secciones de la obra' }).getByRole('link', { name: 'Ingresos', exact: true }).click();
  // First visit compiles the new route in `next dev`; production has no such delay.
  await expect(page).toHaveURL(new RegExp(`/obras/${workId}/ingresos$`), { timeout: 30_000 });
  const table = page.getByRole('table', { name: 'Ingresos de la obra' });
  await expect(table.getByRole('row')).toHaveCount(3);
  // The period filter does not apply to incomes, so it is not offered here.
  await expect(page.getByLabel('Periodo', { exact: true })).toHaveCount(0);
  const reconciled = table.getByRole('row').filter({ hasText: 'I-00002' });
  // 120000.0050 rounds HALF_UP to $120,000.01 (no truncation).
  await expect(reconciled).toContainText('$120,000.01');
  await expect(reconciled).toContainText('Conciliado');
  await expect(reconciled).toContainText('transferencia.pdf');
  await expect(table.getByRole('row').filter({ hasText: 'I-00001' })).toContainText('Pendiente');
  await expect(table.getByRole('row').filter({ hasText: 'I-00001' })).toContainText('Sin comprobantes');
  await expect(page.getByTestId('income-total')).toHaveText('$170,000.01');
  await expect(page.getByTestId('income-pending')).toHaveText('$50,000.00');
  await expect(page.getByTestId('income-reconciled')).toHaveText('$120,000.01');
  const popup = page.waitForEvent('popup');
  await table.getByRole('button', { name: 'Ver transferencia.pdf del ingreso I-00002' }).click();
  expect((await popup).url()).toContain('token=ingreso');
  const download = page.waitForEvent('download');
  await table.getByRole('button', { name: 'Descargar transferencia.pdf del ingreso I-00002' }).click();
  await download;
  expect(signed).toHaveLength(2);
  expect(signed[0]).toContain(`/${workId}/71717171-7171-4171-8171-717171717171/`);
  expect(mutations).toEqual([]);
});

test('Ingresos: registrar con arrastrar y soltar varios comprobantes; el reintento no duplica el ingreso', async ({ page }) => {
  const incomeId = '74747474-7474-4474-8474-747474747474';
  const created: Record<string, unknown>[] = [];
  const uploads: { path: string; type: string | undefined }[] = [];
  const linked: string[] = [];
  let listed = [incomeRows[1]];
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { ...incomeRows[1], id: incomeId, folio: 'I-00003', concept: 'Estimación 2', amount: '85000.5000', received_on: '2026-09-28', receipts: [] } });
    } else {
      await route.fulfill({ json: listed });
    }
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push({ path: decodeURIComponent(new URL(route.request().url()).pathname), type: uploadedPartType(route.request().postDataBuffer()) });
    if (uploads.length === 1) await route.fulfill({ status: 500, json: { message: 'Fallo simulado de subida' } });
    else await route.fulfill({ json: { Key: 'ok' } });
  });
  await page.route(`**/api/v1/incomes/${incomeId}/receipts`, async (route) => {
    linked.push(route.request().postDataJSON().path);
    await route.fulfill({ json: { ...incomeRows[1], id: incomeId, folio: 'I-00003', receipts: [] } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  await page.getByRole('button', { name: 'Nuevo ingreso' }).click();
  const form = page.getByRole('form', { name: 'Nuevo ingreso' });
  await form.getByLabel('Fecha').fill('2026-09-28');
  await form.getByLabel('Concepto').fill('Estimación 2');
  await form.getByLabel('Importe').fill('85000.50');
  await expect(form.getByText('$85,000.50')).toBeVisible();
  // Real drag & drop of two files onto the drop zone.
  const files = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['%PDF-1.4'], 'transferencia.pdf', { type: 'application/pdf' }));
    transfer.items.add(new File(['jpg'], 'factura.jpg', { type: 'image/jpeg' }));
    return transfer;
  });
  const dropzone = form.locator('.dropzone');
  await dropzone.dispatchEvent('dragover', { dataTransfer: files });
  await expect(dropzone).toHaveClass(/dragging/);
  await dropzone.dispatchEvent('drop', { dataTransfer: files });
  await expect(form.locator('.receipt-list li')).toHaveCount(2);
  // A non PDF/image file is refused without being added.
  await form.getByLabel('Comprobantes del ingreso').setInputFiles({ name: 'datos.xml', mimeType: 'application/xml', buffer: Buffer.from('<x/>') });
  await expect(form.getByRole('alert')).toContainText('datos.xml: sólo PDF o imagen');
  await expect(form.locator('.receipt-list li')).toHaveCount(2);

  await form.getByRole('button', { name: 'Registrar ingreso' }).click();
  await expect(form.getByRole('alert')).toContainText('El ingreso I-00003 ya está guardado');
  await expect(form.getByLabel('Importe')).toBeDisabled();
  listed = [{ ...incomeRows[1], id: incomeId, folio: 'I-00003', concept: 'Estimación 2', amount: '85000.5000', received_on: '2026-09-28', receipts: [] }, incomeRows[1]];
  await form.getByRole('button', { name: 'Reintentar comprobantes (1)' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ingreso I-00003 registrado.' })).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Ingresos de la obra' }).getByRole('row').filter({ hasText: 'I-00003' })).toContainText('$85,000.50');
  expect(created).toEqual([{ received_on: '2026-09-28', concept: 'Estimación 2', amount: '85000.50', state: 'pendiente' }]);
  // PDF failed once and was retried alone; the image uploaded; both linked once.
  expect(uploads.map((upload) => upload.type)).toEqual(['application/pdf', 'image/jpeg', 'application/pdf']);
  expect(uploads.every((upload) => upload.path.includes(`/${workId}/${incomeId}/`))).toBe(true);
  expect(linked).toHaveLength(2);
  expect(new Set(linked).size).toBe(2);
});

test('Ingresos: operativo consulta pero no registra', async ({ page }) => {
  await page.route(new RegExp(`/api/v1/works/${workId}$`), async (route) => {
    await route.fulfill({ json: { id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', fecha_inicio: '2026-01-01', fecha_fin: null, estado: 'activa', areas: 1, partidas: 1, permissions: { can_manage: false, can_validate: false } } });
  });
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: incomeRows }); });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  await expect(page.getByRole('table', { name: 'Ingresos de la obra' }).getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Nuevo ingreso' })).toHaveCount(0);
});

test('Ingresos: el estado vacío no ofrece registrar a operativo', async ({ page }) => {
  await page.route(new RegExp(`/api/v1/works/${workId}$`), async (route) => {
    await route.fulfill({ json: { id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', fecha_inicio: '2026-01-01', fecha_fin: null, estado: 'activa', areas: 1, partidas: 1, permissions: { can_manage: false, can_validate: false } } });
  });
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: [] }); });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  await expect(page.getByRole('heading', { name: 'Aún no hay ingresos registrados en esta obra' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrar el primer ingreso' })).toHaveCount(0);
});

test('Resumen: tarjetas de ingresos, gráfica de flujo con tooltip y Gasto por partida colapsable', async ({ page }) => {
  await login(page);
  await page.goto(`/obras/${workId}`);
  await expect(page.getByTestId('overview-income-total')).toHaveText('$170,000.01');
  await expect(page.getByTestId('overview-income-reconciled')).toHaveText('$120,000.01');
  await expect(page.getByTestId('overview-income-pending')).toHaveText('$50,000.00');
  // Net flow = reconciled − validated, with sign and words (not only color).
  await expect(page.getByTestId('overview-net-flow')).toHaveText('+$101,550.01');
  await expect(page.getByText('Superávit: conciliado menos gasto validado')).toBeVisible();

  // Common axis ending at a round $200,000: widths are proportional to the amounts.
  const expense = page.getByTestId('cashflow-bar-validated');
  const income = page.getByTestId('cashflow-bar-reconciled');
  await expect(expense.locator('.cashflow-bar')).toHaveAttribute('data-width', '9.22');
  await expect(income.locator('.cashflow-bar')).toHaveAttribute('data-width', '60.00');
  await expect(expense).toContainText('$18,450.00');
  await expect(income).toContainText('$120,000.01');
  await expect(page.getByRole('list', { name: 'Leyenda', exact: true })).toContainText('Ingreso conciliado');
  await expect(page.getByTestId('cashflow-health')).toContainText('cubre 650.4 % del gasto validado');
  await expect(page.getByTestId('cashflow-health')).toContainText('Gasto cubierto');
  // Tooltip on hover and on keyboard focus (desktop; phones rely on the direct labels).
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  if (test.info().project.name === 'mobile-chromium') {
    await income.click();
    await expect(page.getByRole('tooltip')).toBeHidden();
  } else {
    await income.hover();
    await expect(page.getByRole('tooltip')).toContainText('Ingreso conciliado');
    await expect(page.getByRole('tooltip')).toContainText('Gasto validado: $18,450.00');
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expense.focus();
    await expect(page.getByRole('tooltip')).toContainText('$18,450.00');
    await expect(expense).toHaveAttribute('aria-describedby', /.+/);
  }
  // Screen-reader table carries the same numbers.
  const table = page.getByRole('table', { name: 'Gasto validado contra ingreso conciliado' });
  await expect(table.getByRole('row', { name: /Ingreso conciliado/ })).toContainText('$120,000.01');

  // "Gasto por partida" starts closed and toggles with aria-expanded.
  const toggle = page.getByRole('button', { name: /Gasto por partida/ });
  await expect(page.getByRole('button', { name: /Control por área/ })).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#spend-breakdown-body')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('item-row-ALBANILERIA')).toBeVisible();
  await toggle.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#spend-breakdown-body')).toBeHidden();
});

test('Resumen: déficit cuando el gasto validado supera al ingreso conciliado', async ({ page }) => {
  await page.route(`**/api/v1/works/${workId}/overview**`, async (route) => {
    await route.fulfill({ json: {
      totals: { budget: '100000', validated: '40000', committed: '40000', available: '60000', projected_available: '60000', execution_percent: '40', pending: '0', pending_count: 0, rejected_count: 0, missing_receipts: 0 },
      period: { validated: '40000', pending: '0' }, areas: [], weekly: [], suppliers: [], categories: [],
      incomes: { total: '10000', reconciled: '10000', pending: '0', count: 1 },
      by_item: [], by_category: [], by_provider: [],
    } });
  });
  await login(page);
  await page.goto(`/obras/${workId}`);
  await expect(page.getByTestId('overview-net-flow')).toHaveText('−$30,000.00');
  await expect(page.getByText('Déficit: conciliado menos gasto validado')).toBeVisible();
  await expect(page.getByTestId('cashflow-health')).toContainText('Cobertura parcial');
  await expect(page.getByTestId('cashflow-health')).toContainText('cubre 25.0 %');
});

const pendingWithReceipt = (id: string, folio: string, amount: string) => ({
  ...incomeRows[1], id, folio, amount, concept: `Estimación ${folio}`, reconciled_at: null, reconciled_by: null, reversal_reason: null,
  receipts: [{ id: `${id.slice(0, 8)}-0000-4000-8000-000000000001`, path: `${workId}/${id}/1759000000000-income-receipt-1-deposito.pdf`, kind: 'pdf', created_at: '2026-09-22T12:00:00Z' }],
});

test('Validación: conciliar ingresos por renglón y por lote; sin comprobante no se puede', async ({ page }) => {
  const a = pendingWithReceipt('75757575-7575-4575-8575-757575757575', 'I-00004', '30000.0000');
  const b = pendingWithReceipt('76767676-7676-4676-8676-767676767676', 'I-00005', '15000.0000');
  const c = pendingWithReceipt('77777777-7777-4777-8777-777777777777', 'I-00006', '5000.0000');
  let rows: Record<string, unknown>[] = [incomeRows[0], incomeRows[1], a, b, c];
  const patches: { id: string; body: unknown }[] = [];
  const batches: unknown[] = [];
  const reconcile = (ids: string[]) => {
    rows = rows.map((row) => ids.includes(row.id as string) ? { ...row, state: 'conciliado', reconciled_by: 'Administrador D89', reconciled_at: '2026-09-29T10:00:00Z' } : row);
  };
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: rows }); });
  await page.route('**/api/v1/incomes/*/status', async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
    expect(route.request().method()).toBe('PATCH');
    patches.push({ id, body: route.request().postDataJSON() });
    reconcile([id]);
    await route.fulfill({ json: rows.find((row) => row.id === id) });
  });
  await page.route('**/api/v1/incomes/reconcile-batch', async (route) => {
    const body = route.request().postDataJSON();
    batches.push(body);
    reconcile(body.income_ids);
    await route.fulfill({ json: { reconciled: body.income_ids.length, income_ids: body.income_ids } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/validacion`);
  // Expenses stay the default view; the selector switches to incomes.
  await expect(page.getByRole('heading', { name: 'Gastos pendientes de validar' })).toBeVisible();
  const selector = page.getByRole('radiogroup', { name: 'Qué validar' });
  await selector.getByRole('radio', { name: 'Conciliar ingresos' }).click();
  await expect(page.getByRole('heading', { name: 'Ingresos pendientes de conciliar' })).toBeVisible();
  await expect(page.getByLabel('Periodo', { exact: true })).toHaveCount(0);
  const pendingTable = page.getByRole('table', { name: 'Ingresos pendientes de conciliar' });
  await expect(pendingTable.getByRole('row')).toHaveCount(5);

  // No receipt: checkbox and action disabled, with the hint.
  const bare = pendingTable.getByRole('row').filter({ hasText: 'I-00001' });
  await expect(bare).toContainText('Adjunta un comprobante en Ingresos');
  await expect(bare.getByRole('checkbox')).toBeDisabled();
  await expect(bare.getByRole('button', { name: 'Conciliar ingreso I-00001' })).toBeDisabled();

  // Per row.
  await pendingTable.getByRole('button', { name: 'Conciliar ingreso I-00004' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ingreso I-00004 conciliado.' })).toBeVisible();
  expect(patches).toEqual([{ id: a.id, body: { state: 'conciliado' } }]);
  await expect(pendingTable.getByRole('row')).toHaveCount(4);

  // Batch.
  const batchButton = page.getByRole('button', { name: /Conciliar seleccionados/ });
  await expect(batchButton).toBeDisabled();
  await pendingTable.getByRole('checkbox', { name: 'Seleccionar ingreso I-00005' }).check();
  await pendingTable.getByRole('checkbox', { name: 'Seleccionar ingreso I-00006' }).check();
  await expect(batchButton).toHaveText('Conciliar seleccionados (2)');
  await batchButton.click();
  await expect(page.getByRole('status').filter({ hasText: '2 ingresos conciliados.' })).toBeVisible();
  expect(batches).toEqual([{ work_id: workId, income_ids: [b.id, c.id] }]);
  await expect(pendingTable.getByRole('row')).toHaveCount(2);
  const reconciledTable = page.getByRole('table', { name: 'Ingresos conciliados' });
  await expect(reconciledTable.getByRole('row')).toHaveCount(5);
  await expect(reconciledTable.getByRole('row').filter({ hasText: 'I-00004' })).toContainText('Administrador D89');
  await expect(batchButton).toHaveText('Conciliar seleccionados (0)');
});

test('Validación: revertir una conciliación exige motivo y se puede cancelar', async ({ page }) => {
  let rows: Record<string, unknown>[] = [incomeRows[0]];
  const patches: unknown[] = [];
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: rows }); });
  await page.route(`**/api/v1/incomes/${incomeRows[0].id}/status`, async (route) => {
    const body = route.request().postDataJSON();
    patches.push(body);
    rows = [{ ...incomeRows[0], state: 'pendiente', reconciled_at: null, reconciled_by: null, reversal_reason: body.reason }];
    await route.fulfill({ json: rows[0] });
  });
  await login(page);
  await page.goto(`/obras/${workId}/validacion`);
  await page.getByRole('radiogroup', { name: 'Qué validar' }).getByRole('radio', { name: 'Conciliar ingresos' }).click();
  const reconciledTable = page.getByRole('table', { name: 'Ingresos conciliados' });
  await expect(reconciledTable).toContainText('Sergio Gómez');
  await reconciledTable.getByRole('button', { name: 'Revertir conciliación del ingreso I-00002' }).click();
  await reconciledTable.getByRole('button', { name: 'Cancelar' }).click();
  await expect(reconciledTable.getByLabel('Motivo de la reversión')).toHaveCount(0);
  await reconciledTable.getByRole('button', { name: 'Revertir conciliación del ingreso I-00002' }).click();
  const confirm = reconciledTable.getByRole('button', { name: 'Confirmar reversión' });
  await expect(confirm).toBeDisabled();
  await reconciledTable.getByLabel('Motivo de la reversión').fill('abc');
  await expect(confirm).toBeDisabled();
  await reconciledTable.getByLabel('Motivo de la reversión').fill('Depósito duplicado');
  await confirm.click();
  await expect(page.getByRole('status').filter({ hasText: 'Conciliación del ingreso I-00002 revertida.' })).toBeVisible();
  expect(patches).toEqual([{ state: 'pendiente', reason: 'Depósito duplicado' }]);
  const pendingTable = page.getByRole('table', { name: 'Ingresos pendientes de conciliar' });
  await expect(pendingTable.getByRole('row').filter({ hasText: 'I-00002' })).toContainText('Revertido: Depósito duplicado');
  await expect(page.getByRole('table', { name: 'Ingresos conciliados' })).toHaveCount(0);
});

test('Validación: un error de la API al conciliar se muestra y no cambia la lista', async ({ page }) => {
  const a = pendingWithReceipt('75757575-7575-4575-8575-757575757575', 'I-00004', '30000.0000');
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: [a] }); });
  await page.route('**/api/v1/incomes/*/status', async (route) => {
    await route.fulfill({ status: 422, json: { detail: 'Adjunta al menos un comprobante antes de conciliar' } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/validacion`);
  await page.getByRole('radiogroup', { name: 'Qué validar' }).getByRole('radio', { name: 'Conciliar ingresos' }).click();
  await page.getByRole('button', { name: 'Conciliar ingreso I-00004' }).click();
  await expect(page.locator('.notice.error')).toContainText('Adjunta al menos un comprobante');
  await expect(page.getByRole('table', { name: 'Ingresos pendientes de conciliar' }).getByRole('row')).toHaveCount(2);
});

test('Ingresos: tarjetas homologadas, quién concilió y estado vacío con acción para administración', async ({ page }) => {
  let rows: Record<string, unknown>[] = incomeRows;
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: rows }); });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  const cards = page.getByRole('region', { name: 'Resumen de ingresos' });
  await expect(cards.locator('.metric-card')).toHaveCount(3);
  const reconciled = page.getByRole('table', { name: 'Ingresos de la obra' }).getByRole('row').filter({ hasText: 'I-00002' });
  await expect(reconciled).toContainText('Sergio Gómez');
  rows = [];
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Aún no hay ingresos registrados en esta obra' })).toBeVisible();
  await page.getByRole('button', { name: 'Registrar el primer ingreso' }).click();
  await expect(page.getByRole('form', { name: 'Nuevo ingreso' })).toBeVisible();
});

// --- Ingresos: consulta y edición ------------------------------------------------------

test('Ingresos: Ver abre la consulta de sólo lectura con comprobantes; operativo no ve Editar', async ({ page }) => {
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/') && request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.route(new RegExp(`/api/v1/works/${workId}$`), async (route) => {
    await route.fulfill({ json: { id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', fecha_inicio: '2026-01-01', fecha_fin: null, estado: 'activa', areas: 1, partidas: 1, permissions: { can_manage: false, can_validate: false } } });
  });
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: incomeRows }); });
  await page.route(`**/api/v1/incomes/${incomeRows[0].id}`, async (route) => { await route.fulfill({ json: incomeRows[0] }); });
  const signed: string[] = [];
  await page.route('**/storage/v1/object/sign/comprobantes/**', async (route) => {
    signed.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ json: { signedURL: '/object/sign/comprobantes/firmado.pdf?token=ingreso' } });
  });
  await page.route('**/storage/v1/object/sign/comprobantes/firmado.pdf**', async (route) => {
    await route.fulfill({ body: '%PDF-1.4', contentType: 'application/pdf' });
  });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  const table = page.getByRole('table', { name: 'Ingresos de la obra' });
  await expect(table.getByRole('columnheader', { name: 'Acciones' })).toBeVisible();
  await expect(table.getByRole('button', { name: /^Editar ingreso/ })).toHaveCount(0);
  const viewButton = table.getByRole('button', { name: 'Ver ingreso I-00002' });
  await viewButton.click();
  const dialog = page.getByRole('dialog', { name: 'Ingreso I-00002' });
  await expect(dialog).toContainText('Consulta de ingreso · sólo lectura');
  await expect(dialog.getByTestId('income-detail-amount')).toHaveText('$120,000.01');
  await expect(dialog).toContainText('Estimación 1');
  await expect(dialog).toContainText('2026-09-20');
  await expect(dialog).toContainText('Conciliado');
  await expect(dialog).toContainText('Sergio Gómez');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  const popup = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Ver transferencia.pdf' }).click();
  expect((await popup).url()).toContain('token=ingreso');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Descargar transferencia.pdf' }).click();
  await download;
  expect(signed).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(viewButton).toBeFocused();
  expect(mutations).toEqual([]);
});

test('Ingresos: Editar prellena, envía sólo lo modificado, conserva y anexa comprobantes', async ({ page }) => {
  const income = incomeRows[0];
  let rows: Record<string, unknown>[] = [...incomeRows];
  const patches: unknown[] = [];
  const uploads: string[] = [];
  const linked: string[] = [];
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: rows }); });
  await page.route(`**/api/v1/incomes/${income.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      const updated = { ...income, ...body, amount: body.amount ?? income.amount };
      rows = [updated, incomeRows[1]];
      await route.fulfill({ json: updated });
    } else {
      await route.fulfill({ json: rows[0] });
    }
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads.push(decodeURIComponent(new URL(route.request().url()).pathname));
    await route.fulfill({ status: uploads.length === 1 ? 500 : 200, json: uploads.length === 1 ? { message: 'Fallo simulado de subida' } : { Key: 'ok' } });
  });
  await page.route(`**/api/v1/incomes/${income.id}/receipts`, async (route) => {
    const path = route.request().postDataJSON().path;
    linked.push(path);
    const current = rows[0] as typeof income;
    const withReceipt = { ...current, receipts: [...current.receipts, { id: '79797979-7979-4979-8979-797979797979', path, kind: 'pdf', created_at: '2026-09-29T12:00:00Z' }] };
    rows = [withReceipt, incomeRows[1]];
    await route.fulfill({ json: withReceipt });
  });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  // Editing also starts from the read-only detail.
  await page.getByRole('button', { name: 'Ver ingreso I-00002' }).click();
  await page.getByRole('dialog', { name: 'Ingreso I-00002' }).getByRole('button', { name: 'Editar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const form = page.getByRole('form', { name: 'Editar ingreso' });
  await expect(form.getByRole('heading', { name: 'Editar ingreso I-00002' })).toBeVisible();
  await expect(form.getByRole('note')).toContainText('ya está conciliado');
  await expect(form.getByLabel('Fecha')).toHaveValue('2026-09-20');
  await expect(form.getByLabel('Concepto')).toHaveValue('Estimación 1');
  await expect(form.getByLabel('Importe')).toHaveValue('120000.005');
  await expect(form).toContainText('Comprobantes actuales (se conservan)');
  await expect(form).toContainText('transferencia.pdf');
  const save = form.getByRole('button', { name: 'Guardar cambios' });
  await expect(save).toBeDisabled();
  await form.getByLabel('Concepto').fill('Estimación 1 corregida');
  await form.getByLabel('Importe').fill('121500.50');
  await form.getByLabel('Comprobantes del ingreso').setInputFiles({ name: 'complemento.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await save.click();
  // The edit was applied; the failed file is retried alone without repeating the PATCH.
  await expect(form.getByRole('alert')).toContainText('Los datos del ingreso I-00002 ya se guardaron');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Ingreso I-00002 actualizado.' })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([{ concept: 'Estimación 1 corregida', amount: '121500.50' }]);
  expect(uploads).toHaveLength(2);
  expect(uploads.every((path) => path.includes(`/${workId}/${income.id}/`))).toBe(true);
  expect(linked).toHaveLength(1);
  const row = page.getByRole('table', { name: 'Ingresos de la obra' }).getByRole('row').filter({ hasText: 'I-00002' });
  await expect(row).toContainText('Estimación 1 corregida');
  await expect(row).toContainText('$121,500.50');
  await expect(row).toContainText('transferencia.pdf');
  await expect(row).toContainText('complemento.pdf');
});

test('Ingresos: Editar sin cambios no envía nada y Cancelar cierra el formulario', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.method() === 'PATCH') requests.push(request.url()); });
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: incomeRows }); });
  await login(page);
  await page.goto(`/obras/${workId}/ingresos`);
  await page.getByRole('button', { name: 'Editar ingreso I-00001' }).click();
  const form = page.getByRole('form', { name: 'Editar ingreso' });
  await expect(form.getByRole('note')).toHaveCount(0);
  await form.getByLabel('Concepto').fill('Anticipo');
  await expect(form.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  await form.getByLabel('Importe').fill('0');
  await form.getByLabel('Concepto').fill('Anticipo 2');
  await expect(form.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  await form.getByRole('button', { name: 'Cancelar' }).click();
  await expect(form).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('Validación: Ver y Editar junto a Conciliar; al guardar la lista refleja el cambio', async ({ page }) => {
  const a = pendingWithReceipt('75757575-7575-4575-8575-757575757575', 'I-00004', '30000.0000');
  let rows: Record<string, unknown>[] = [a, incomeRows[0]];
  const patches: unknown[] = [];
  await page.route(`**/api/v1/works/${workId}/incomes`, async (route) => { await route.fulfill({ json: rows }); });
  await page.route(`**/api/v1/incomes/${a.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON();
      patches.push(body);
      const updated = { ...a, ...body };
      rows = [updated, incomeRows[0]];
      await route.fulfill({ json: updated });
    } else {
      await route.fulfill({ json: rows[0] });
    }
  });
  await login(page);
  await page.goto(`/obras/${workId}/validacion`);
  await page.getByRole('radiogroup', { name: 'Qué validar' }).getByRole('radio', { name: 'Conciliar ingresos' }).click();
  const pendingTable = page.getByRole('table', { name: 'Ingresos pendientes de conciliar' });
  const row = pendingTable.getByRole('row').filter({ hasText: 'I-00004' });
  await expect(row.getByRole('button', { name: 'Ver ingreso I-00004' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Editar ingreso I-00004' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Conciliar ingreso I-00004' })).toBeVisible();
  const reconciledTable = page.getByRole('table', { name: 'Ingresos conciliados' });
  await expect(reconciledTable.getByRole('button', { name: 'Ver ingreso I-00002' })).toBeVisible();
  await expect(reconciledTable.getByRole('button', { name: 'Editar ingreso I-00002' })).toBeVisible();
  await expect(reconciledTable.getByRole('button', { name: 'Revertir conciliación del ingreso I-00002' })).toBeVisible();

  await row.getByRole('button', { name: 'Ver ingreso I-00004' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ingreso I-00004' });
  await expect(dialog.getByTestId('income-detail-amount')).toHaveText('$30,000.00');
  await dialog.getByRole('button', { name: 'Cerrar' }).click();

  await row.getByRole('button', { name: 'Editar ingreso I-00004' }).click();
  const form = page.getByRole('form', { name: 'Editar ingreso' });
  await expect(form.getByLabel('Concepto')).toHaveValue('Estimación I-00004');
  await form.getByLabel('Concepto').fill('Estimación 3 revisada');
  await form.getByLabel('Importe').fill('32000');
  await form.getByLabel('Fecha').fill('2026-09-10');
  await form.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Ingreso I-00004 actualizado.' })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(patches).toEqual([{ received_on: '2026-09-10', concept: 'Estimación 3 revisada', amount: '32000' }]);
  const refreshed = pendingTable.getByRole('row').filter({ hasText: 'I-00004' });
  await expect(refreshed).toContainText('Estimación 3 revisada');
  await expect(refreshed).toContainText('$32,000.00');
  await expect(refreshed).toContainText('2026-09-10');
});

// --- Cambio 8: jerarquía de 23 partidas y NEODATA opcional ------------------------------

test('Resumen: gasto por partida en eje común y barra por categoría con tooltip', async ({ page }, testInfo) => {
  await login(page);
  await page.goto(`/obras/${workId}`);
  // The NEODATA budget remains the global ceiling on the summary cards.
  await expect(page.getByText('Presupuesto vigente')).toBeVisible();
  await page.getByRole('button', { name: /Gasto por partida/ }).click();
  const rows = page.locator('.item-group > .item-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-testid', 'item-row-ALBANILERIA');
  const albanileria = page.getByTestId('item-row-ALBANILERIA');
  // Common axis = largest committed item ($14,000): 12,000 → 85.71 %, 6,450 → 46.07 %.
  await expect(albanileria.locator('.item-bar.validated')).toHaveAttribute('data-width', '85.71');
  await expect(page.getByTestId('item-row-PRELIMINARES').locator('.item-bar.validated')).toHaveAttribute('data-width', '46.07');
  await expect(albanileria).toContainText('$12,000.00');
  await expect(albanileria).toContainText('+ $2,000.00 pend.');
  await expect(albanileria).toContainText('3 gastos · 65.0 % del validado');
  await expect(page.getByTestId('category-MATERIAL')).toContainText('$15,450.00');
  await expect(page.getByTestId('category-MATERIAL')).toContainText('83.7 %');
  await expect(page.getByTestId('category-EQUIPO/HERR')).toContainText('$0.00');
  await expect(page.getByTestId('category-segment-MATERIAL')).toBeVisible();
  await expect(page.getByTestId('category-segment-EQUIPO/HERR')).toHaveCount(0); // no zero-width segment
  const byItem = page.getByRole('table', { name: 'Gasto acumulado por partida y subpartida' });
  await expect(byItem.getByRole('row', { name: /^PRELIMINARES \$/ })).toContainText('$2,150.00');
  await expect(page.getByRole('table', { name: 'Gasto validado por categoría' }).getByRole('row', { name: /MANO DE OBRA/ })).toContainText('$3,000.00');
  if (testInfo.project.name === 'desktop-chromium') {
    await albanileria.hover();
    await expect(page.getByRole('tooltip')).toContainText('MATERIAL: $9,000.00');
    await expect(page.getByRole('tooltip')).toContainText('MANO DE OBRA: $3,000.00');
    await page.getByTestId('category-segment-MANO DE OBRA').focus();
    await expect(page.getByRole('tooltip')).toContainText('16.3 % del gasto validado');
  }
});

test('Resumen: desglose vacío explica que aún no hay gasto', async ({ page }) => {
  await page.route(`**/api/v1/works/${workId}/overview**`, async (route) => {
    await route.fulfill({ json: {
      totals: { budget: '100000', validated: '0', committed: '0', available: '100000', projected_available: '100000', execution_percent: '0', pending: '0', pending_count: 0, rejected_count: 0, missing_receipts: 0 },
      period: { validated: '0', pending: '0' }, areas: [], weekly: [], suppliers: [], categories: [],
      incomes: { total: '0', reconciled: '0', pending: '0', count: 0 },
      by_item: [], by_provider: [],
      by_category: [{ ...spend('MATERIAL', '0', '0', 0), id: expenseCategoryId }],
    } });
  });
  await login(page);
  await page.goto(`/obras/${workId}`);
  await page.getByRole('button', { name: /Gasto por partida/ }).click();
  await expect(page.getByText('Aún no hay gastos registrados en el periodo.')).toBeVisible();
  await expect(page.getByText('Aún no hay gastos con proveedor en el periodo.')).toBeVisible();
  await expect(page.getByTestId('category-empty')).toBeVisible();
});

test('gasto: vincular a NEODATA es opcional; se vincula, se quita y se vuelve a vincular', async ({ page }) => {
  const payloads: Record<string, unknown>[] = [];
  await page.route('**/api/v1/expenses', async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  const toggle = form.getByRole('button', { name: /Vincular a NEODATA \(Opcional\)/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const budget = form.getByLabel('Partida NEODATA');
  await expect(budget).toBeDisabled(); // needs an area first
  await form.getByLabel('Buscar área NEODATA').fill('oficina');
  await expect(form.getByLabel('Área NEODATA', { exact: true })).toHaveValue(areaId);
  await budget.selectOption(budgetItemId);
  await expect(form.getByTestId('neodata-summary')).toHaveText('OFICINA · ALB-05');
  await form.getByRole('button', { name: 'Quitar vínculo' }).click();
  await expect(form.getByTestId('neodata-summary')).toHaveText('Sin área específica');
  await expect(form.getByLabel('Área NEODATA', { exact: true })).toHaveValue('');
  await expect(budget).toBeDisabled();
  await form.getByLabel('Área NEODATA', { exact: true }).selectOption(areaId);
  await budget.selectOption(budgetItemId);
  // Collapsing keeps the link and the summary tells what is linked.
  await toggle.click();
  await expect(form.getByTestId('neodata-summary')).toHaveText('OFICINA · ALB-05');
  await chooseClassification(form);
  await fillLines(form, [{ description: 'Firme', price: '500' }]);
  await form.getByLabel('Concepto general').fill('Firme de oficina');
  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ area_id: areaId, budget_item_id: budgetItemId, supplier_id: supplierId });
});

test('gasto: al corregir un gasto con área, el bloque NEODATA abre con su vínculo y se puede quitar', async ({ page }) => {
  const patches: Record<string, unknown>[] = [];
  await page.route('**/api/v1/expenses/44444444-4444-4444-8444-444444444444', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patches.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const form = page.locator('form.work-expense-form');
  await expect(form.getByRole('heading', { name: 'Corregir gasto G-00001' })).toBeVisible();
  await expect(form.getByRole('button', { name: /Vincular a NEODATA/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(form.getByLabel('Área NEODATA', { exact: true })).toHaveValue(areaId);
  await expect(form.getByLabel('Proveedor', { exact: true })).toHaveValue(supplierId);
  await form.getByRole('button', { name: 'Quitar vínculo' }).click();
  await form.getByRole('button', { name: 'Guardar corrección' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto corregido correctamente' })).toBeVisible();
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({ area_id: null, budget_item_id: null, supplier_id: supplierId });
});

test('gastos: la clasificación muestra partida primero y el área sólo como dato secundario', async ({ page }) => {
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  const cell = page.getByRole('cell', { name: /PRELIMINARES › LIMPIEZA/ });
  await expect(cell).toContainText('MATERIAL · Área: OFICINA');
  await expect(page.getByRole('columnheader', { name: 'Clasificación' })).toBeVisible();
});

test('gasto: Partida, Subpartida y Categoría exigen una elección explícita', async ({ page }) => {
  const thirdSubpartidaId = '13131313-1313-4313-8313-131313131313';
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    const json = workCatalog();
    // ALBANILERIA with two subpartidas: none is auto-selected.
    await route.fulfill({ json: { ...json, expense_subitems: [...json.expense_subitems, { id: thirdSubpartidaId, partida_id: secondExpensePartidaId, nombre: 'MUROS' }] } });
  });
  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  const partida = form.getByLabel('Partida', { exact: true });
  const subpartida = form.getByLabel('Subpartida', { exact: true });
  const categoria = form.getByLabel('Categoría', { exact: true });
  const save = form.getByRole('button', { name: /Guardar pendiente/ });
  await expect(partida).toHaveValue('');
  await expect(partida.locator('option').first()).toHaveText('Seleccionar partida');
  await expect(categoria).toHaveValue('');
  await expect(categoria.locator('option').first()).toHaveText('Seleccionar categoría');
  await expect(subpartida).toBeDisabled();
  await expect(subpartida.locator('option').first()).toHaveText('Primero elige una partida');
  await chooseSupplier(form);
  await fillLines(form, [{ description: 'Block', price: '50' }]);
  await form.getByLabel('Concepto general').fill('Block para muros');
  await expect(save).toBeDisabled();
  await partida.selectOption(secondExpensePartidaId);
  await expect(subpartida).toBeEnabled();
  await expect(subpartida).toHaveValue('');
  await expect(subpartida.locator('option').first()).toHaveText('Seleccionar subpartida');
  await expect(save).toBeDisabled();
  await subpartida.selectOption(thirdSubpartidaId);
  await expect(save).toBeDisabled(); // category still missing
  await categoria.selectOption(expenseCategoryId);
  await expect(save).toBeEnabled();
  // Changing the partida clears the subpartida again.
  await partida.selectOption(expensePartidaId);
  await expect(subpartida).toHaveValue(expenseSubpartidaId); // single option: nothing to choose
  await partida.selectOption('');
  await expect(subpartida).toBeDisabled();
  await expect(save).toBeDisabled();
});

test('Resumen: drill-down Partida → Subpartida → Categoría con importes validados y pendientes', async ({ page }) => {
  await login(page);
  await page.goto(`/obras/${workId}`);
  await page.getByRole('button', { name: /Gasto por partida/ }).click();
  const albanileria = page.getByTestId('item-row-ALBANILERIA');
  await expect(albanileria).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('region', { name: 'Subpartidas de ALBANILERIA' })).toBeHidden();
  await albanileria.click();
  await expect(albanileria).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Subpartidas de ALBANILERIA' });
  await expect(panel.locator('.subitem')).toHaveCount(2);
  const firmes = page.getByTestId('subitem-ALBANILERIA-FIRMES-Y-HORMIGONES');
  await expect(firmes).toContainText('$9,000.00');
  await expect(firmes).toContainText('+ $2,000.00 pend.');
  await expect(firmes.getByTestId('chip-MATERIAL')).toContainText('$9,000.00');
  await expect(firmes.getByTestId('chip-MATERIAL')).toContainText('+ $2,000.00 pend.');
  const muros = page.getByTestId('subitem-ALBANILERIA-MUROS');
  await expect(muros.getByTestId('chip-MANO-DE-OBRA')).toContainText('$3,000.00');
  await expect(muros.getByTestId('chip-MATERIAL')).toHaveCount(0);
  // Subitem bars share the chart axis ($14,000): 9,000 → 64.29 %.
  await expect(firmes.locator('.item-bar.validated')).toHaveAttribute('data-width', '64.29');
  // Other partidas stay collapsed; keyboard toggles too.
  await expect(page.getByRole('region', { name: 'Subpartidas de PRELIMINARES' })).toBeHidden();
  await albanileria.press('Enter');
  await expect(albanileria).toHaveAttribute('aria-expanded', 'false');
  await expect(panel).toBeHidden();
  const table = page.getByRole('table', { name: 'Gasto acumulado por partida y subpartida' });
  await expect(table.getByRole('row', { name: /ALBANILERIA › MUROS/ })).toContainText('$3,000.00');
});

test('Resumen: gasto por proveedor ordenado, con importes, porcentajes y tooltip', async ({ page }, testInfo) => {
  await login(page);
  await page.goto(`/obras/${workId}`);
  await expect(page.getByRole('heading', { name: 'Principales proveedores' })).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Gasto por proveedor' });
  const rows = panel.locator('.provider-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute('data-testid', 'provider-row-Concretos Toluca');
  const concretos = page.getByTestId('provider-row-Concretos Toluca');
  await expect(concretos).toContainText('$14,450.00');
  await expect(concretos).toContainText('+ $4,150.00 pend.');
  await expect(concretos).toContainText('4 gastos · 78.3 % del validado');
  await expect(page.getByTestId('provider-row-Aceros del Centro')).toContainText('1 gasto · 21.7 % del validado');
  // Common axis = largest committed ($18,600): 14,450 → 77.69 %, 4,000 → 21.51 %.
  await expect(concretos.locator('.item-bar.validated')).toHaveAttribute('data-width', '77.69');
  await expect(page.getByTestId('provider-row-Aceros del Centro').locator('.item-bar.validated')).toHaveAttribute('data-width', '21.51');
  const table = page.getByRole('table', { name: 'Gasto por proveedor' });
  await expect(table.getByRole('row', { name: /Aceros del Centro/ })).toContainText('$4,000.00');
  if (testInfo.project.name === 'desktop-chromium') {
    await concretos.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('$14,450.00 validado');
    await expect(tooltip).toContainText('$4,150.00 pendiente');
    await expect(tooltip).toContainText('78.3 % del gasto validado de la obra');
    await page.mouse.move(0, 0);
    await page.getByTestId('provider-row-Aceros del Centro').focus();
    await expect(page.getByRole('tooltip')).toContainText('Aceros del Centro');
  }
});

// --- Subcontratos (Cambio 9) ------------------------------------------------------------

const subcontractId = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';

function subcontractRow(overrides: Record<string, unknown> = {}) {
  return {
    id: subcontractId, work_id: workId, folio: 'SC-0001', supplier_id: supplierId, supplier_name: 'Concretos Toluca',
    expense_item_id: secondExpensePartidaId, expense_item: 'ALBANILERIA', expense_subitem_id: secondExpenseSubpartidaId,
    expense_subitem: 'FIRMES Y HORMIGONES', category: 'MANO DE OBRA', description: 'Colado de firmes',
    contracted_amount: '10000.0000', retention_percent: '5.00', state: 'activo', created_at: '2026-09-20T12:00:00Z',
    estimated_gross: '0.0000', paid_net: '0.0000', retained: '0.0000', retention_returned: '0.0000',
    retention_available: '0.0000', advances_paid: '0.0000',
    advance_pending_amortization: '0.0000', remaining_to_estimate: '10000.0000', estimations: [],
    ...overrides,
  };
}

function estimationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '6d6d6d6d-6d6d-4d6d-8d6d-6d6d6d6d6d6d', subcontract_id: subcontractId, number: 1, folio: 'EST-01',
    estimated_on: '2026-09-21', kind: 'anticipo', gross_amount: '1000.0000', advance_amortization: '0.0000',
    retention_amount: '0.0000', additions: '0.0000', deductions: '0.0000', net_amount: '1000.0000',
    adjustment_notes: null, state: 'pagado', paid_at: '2026-09-22T15:00:00Z', paid_by: 'Sergio Gómez',
    created_at: '2026-09-21T12:00:00Z', ...overrides,
  };
}

test('Subcontratos: alta de subcontrato y estimación con retención y neto calculados en vivo', async ({ page }) => {
  let list: Record<string, unknown>[] = [];
  let detail = subcontractRow();
  const created: unknown[] = [];
  const estimations: unknown[] = [];
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      list = [detail];
      await route.fulfill({ status: 201, json: detail });
    } else {
      await route.fulfill({ json: list });
    }
  });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => { await route.fulfill({ json: detail }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}/estimations`, async (route) => {
    const body = route.request().postDataJSON();
    estimations.push(body);
    const saved = estimationRow({ kind: 'avance', state: 'borrador', paid_at: null, paid_by: null, gross_amount: '4000.0000', additions: '200.0000', deductions: '100.0000', retention_amount: '200.0000', net_amount: '3900.0000', adjustment_notes: body.adjustment_notes });
    detail = subcontractRow({ estimations: [saved], estimated_gross: '4000.0000', remaining_to_estimate: '6000.0000' });
    await route.fulfill({ status: 201, json: saved });
  });
  await login(page);
  await page.goto(`/obras/${workId}/gastos`);
  await page.getByRole('navigation', { name: 'Secciones de la obra' }).getByRole('link', { name: 'Subcontratos', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/obras/${workId}/subcontratos$`), { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Aún no hay subcontratos en esta obra' })).toBeVisible();
  await expect(page.getByLabel('Periodo', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Nuevo subcontrato' }).click();
  const form = page.getByRole('form', { name: 'Nuevo subcontrato' });
  const save = form.getByRole('button', { name: 'Registrar subcontrato' });
  await expect(form.getByLabel('Categoría', { exact: true })).toHaveValue('MANO DE OBRA');
  await expect(form.getByLabel('Subpartida', { exact: true })).toBeDisabled();
  await expect(save).toBeDisabled();
  await form.getByLabel('Proveedor', { exact: true }).selectOption(supplierId);
  await form.getByLabel('Partida', { exact: true }).selectOption(secondExpensePartidaId);
  await expect(form.getByLabel('Subpartida', { exact: true })).toHaveValue(secondExpenseSubpartidaId);
  await form.getByLabel('Importe contratado').fill('10,000');
  await expect(form.getByText('$10,000.00')).toBeVisible();
  await form.getByLabel('% Fondo de garantía').fill('5');
  await form.getByLabel('Descripción').fill('Colado de firmes');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Subcontrato SC-0001 registrado.' })).toBeVisible();
  expect(created).toEqual([{ supplier_id: supplierId, expense_item_id: secondExpensePartidaId, expense_subitem_id: secondExpenseSubpartidaId, description: 'Colado de firmes', contracted_amount: '10000', retention_percent: '5' }]);

  // The detail opens with the financial summary.
  const detailPanel = page.getByRole('region', { name: /SC-0001 · Concretos Toluca/ });
  await expect(detailPanel.getByTestId('sc-contracted')).toHaveText('$10,000.00');
  await expect(detailPanel.getByTestId('sc-paid')).toHaveText('$0.00');
  await detailPanel.getByRole('button', { name: 'Nueva estimación' }).click();
  const estimation = page.getByRole('form', { name: 'Nueva estimación' });
  const net = estimation.getByTestId('preview-net');
  await estimation.getByLabel('Importe bruto').fill('4000');
  await expect(estimation.getByTestId('preview-retention')).toHaveText('$200.00');
  await expect(net).toHaveText('$3,800.00');
  await estimation.getByLabel('Aditivas').fill('200');
  await expect(net).toHaveText('$4,000.00');
  await estimation.getByLabel('Deductivas').fill('100');
  await expect(net).toHaveText('$3,900.00');
  // Adjustments need a justification before saving.
  await expect(estimation.getByRole('alert')).toContainText('Justifica las aditivas o deductivas');
  await expect(estimation.getByRole('button', { name: 'Registrar estimación' })).toBeDisabled();
  await estimation.getByLabel('Notas de ajustes').fill('Firme extra; daño en muro');
  await estimation.getByRole('button', { name: 'Registrar estimación' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estimación EST-01 registrada como borrador.' })).toBeVisible();
  expect(estimations).toEqual([{ estimated_on: expect.any(String), kind: 'avance', gross_amount: '4000', advance_amortization: '0', additions: '200', deductions: '100', adjustment_notes: 'Firme extra; daño en muro' }]);
  const history = page.getByRole('table', { name: 'Historial de estimaciones de SC-0001' });
  const row = history.getByRole('row').filter({ hasText: 'EST-01' });
  await expect(row).toContainText('$3,900.00');
  await expect(row).toContainText('Borrador');
  await expect(page.getByRole('table', { name: 'Subcontratos de la obra' }).getByRole('row').filter({ hasText: 'SC-0001' })).toContainText('Activo');
});

test('Subcontratos: retención HALF_UP y reglas de anticipo, amortización y finiquito en vivo', async ({ page }) => {
  const paidAdvance = estimationRow();
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [subcontractRow({ advances_paid: '1000.0000', advance_pending_amortization: '1000.0000' })] }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => {
    await route.fulfill({ json: subcontractRow({ estimations: [paidAdvance], paid_net: '1000.0000', advances_paid: '1000.0000', advance_pending_amortization: '1000.0000' }) });
  });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await page.getByRole('button', { name: 'Ver subcontrato SC-0001' }).click();
  await page.getByRole('button', { name: 'Nueva estimación' }).click();
  const form = page.getByRole('form', { name: 'Nueva estimación' });
  const save = form.getByRole('button', { name: 'Registrar estimación' });
  // 100.10 × 5 % = 5.005 → 5.01 (half up, like the server).
  await form.getByLabel('Importe bruto').fill('100.10');
  await expect(form.getByTestId('preview-retention')).toHaveText('$5.01');
  await expect(form.getByTestId('preview-net')).toHaveText('$95.09');
  await expect(form.getByText('Anticipo pagado pendiente: $1,000.00')).toBeVisible();
  // Amortization cannot exceed the paid advance pending.
  await form.getByLabel('Amortización de anticipo').fill('1000.01');
  await expect(form.getByRole('alert')).toContainText('excede el anticipo pagado');
  await expect(save).toBeDisabled();
  // A negative net is never allowed.
  await form.getByLabel('Amortización de anticipo').fill('96');
  await expect(form.getByRole('alert')).toContainText('no puede ser negativo');
  // The finiquito proposes amortizing everything pending and requires it.
  await form.getByLabel('Tipo').selectOption('finiquito');
  await expect(form.getByLabel('Amortización de anticipo')).toHaveValue('1000');
  await form.getByLabel('Importe bruto').fill('6000');
  await expect(form.getByTestId('preview-net')).toHaveText('$4,700.00'); // 6000 − 300 − 1000
  await expect(save).toBeEnabled();
  await form.getByLabel('Amortización de anticipo').fill('900');
  await expect(form.getByRole('alert')).toContainText('debe amortizar todo el anticipo');
  // An anticipo is paid in full: adjustments are disabled and there is no retention.
  await form.getByLabel('Tipo').selectOption('anticipo');
  await expect(form.getByLabel('Aditivas')).toBeDisabled();
  await expect(form.getByLabel('Amortización de anticipo')).toHaveValue('');
  await form.getByLabel('Importe bruto').fill('2000');
  await expect(form.getByTestId('preview-retention')).toHaveText('$0.00');
  await expect(form.getByTestId('preview-net')).toHaveText('$2,000.00');
  // Contract cap: 1,000 already advanced + 9,000.01 > 10,000.
  await form.getByLabel('Importe bruto').fill('9000.01');
  await expect(form.getByRole('alert')).toContainText('Los anticipos exceden el importe contratado');
});

test('Subcontratos: Pagar/Aprobar con confirmación y descarga del recibo PDF', async ({ page }) => {
  let paid = false;
  const draft = estimationRow({ id: '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e', number: 2, folio: 'EST-02', kind: 'avance', state: 'borrador', paid_at: null, paid_by: null, gross_amount: '4000.0000', retention_amount: '200.0000', advance_amortization: '500.0000', net_amount: '3300.0000' });
  const receipts: string[] = [];
  const patches: unknown[] = [];
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [subcontractRow()] }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => {
    const current = paid ? { ...draft, state: 'pagado', paid_by: 'Sergio Gómez', paid_at: '2026-09-30T12:00:00Z', expense_id: '8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f', expense_folio: 'G-00042' } : draft;
    await route.fulfill({ json: subcontractRow({ estimations: [estimationRow(), current], paid_net: paid ? '4300.0000' : '1000.0000', retained: paid ? '200.0000' : '0.0000' }) });
  });
  await page.route(`**/api/v1/subcontracts/${subcontractId}/estimations/${draft.id}/status`, async (route) => {
    patches.push(route.request().postDataJSON());
    paid = true;
    await route.fulfill({ json: { ...draft, state: 'pagado' } });
  });
  await page.route(`**/api/v1/subcontracts/${subcontractId}/estimations/*/receipt.pdf`, async (route) => {
    receipts.push(new URL(route.request().url()).pathname);
    await route.fulfill({ body: '%PDF-1.4 recibo', contentType: 'application/pdf' });
  });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await page.getByRole('button', { name: 'Ver subcontrato SC-0001' }).click();
  const history = page.getByRole('table', { name: 'Historial de estimaciones de SC-0001' });
  const row = history.getByRole('row').filter({ hasText: 'EST-02' });
  // The paid anticipo has no pay/edit/delete actions, only its receipt.
  const advanceRow = history.getByRole('row').filter({ hasText: 'EST-01' });
  await expect(advanceRow.getByRole('button', { name: /Pagar/ })).toHaveCount(0);
  await expect(advanceRow).toContainText('Sergio Gómez');
  await row.getByRole('button', { name: 'Pagar estimación EST-02' }).click();
  const confirm = row.getByRole('group', { name: 'Confirmar pago de EST-02' });
  await expect(confirm).toContainText('¿Pagar $3,300.00? Se registrará como gasto validado de hoy y no se puede revertir.');
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  expect(patches).toEqual([]);
  await row.getByRole('button', { name: 'Pagar estimación EST-02' }).click();
  await row.getByRole('button', { name: 'Confirmar pago' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Estimación EST-02 pagada; se registró el gasto validado.' })).toBeVisible();
  expect(patches).toEqual([{ state: 'pagado' }]);
  await expect(row).toContainText('Pagado');
  // Financial bridge: the payment shows the validated expense it created.
  await expect(row.getByTestId('expense-link-EST-02')).toHaveText('Gasto G-00042 (validado)');
  await expect(page.getByTestId('sc-paid')).toHaveText('$4,300.00');
  await expect(page.getByTestId('sc-retained')).toHaveText('$200.00');
  const download = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Descargar recibo de EST-02' }).click();
  expect((await download).suggestedFilename()).toBe('recibo-SC-0001-EST-02.pdf');
  expect(receipts).toEqual([`/api/v1/subcontracts/${subcontractId}/estimations/${draft.id}/receipt.pdf`]);
});

test('Subcontratos: operativo consulta y descarga recibos, sin registrar ni pagar', async ({ page }) => {
  await page.route(new RegExp(`/api/v1/works/${workId}$`), async (route) => {
    await route.fulfill({ json: { id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', fecha_inicio: '2026-01-01', fecha_fin: null, estado: 'activa', areas: 1, partidas: 1, permissions: { can_manage: false, can_validate: false } } });
  });
  const draft = estimationRow({ folio: 'EST-02', id: '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e', state: 'borrador', paid_at: null, paid_by: null });
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [subcontractRow()] }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => { await route.fulfill({ json: subcontractRow({ estimations: [draft] }) }); });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await expect(page.getByRole('button', { name: 'Nuevo subcontrato' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Editar subcontrato SC-0001' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Ver subcontrato SC-0001' }).click();
  await expect(page.getByRole('button', { name: 'Nueva estimación' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pagar estimación/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Cancelar subcontrato/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Descargar recibo de EST-02' })).toBeVisible();
});

test('Subcontratos: Exportar Nómina (Excel) de la semana actual o de un rango elegido', async ({ page }) => {
  const requests: URLSearchParams[] = [];
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [subcontractRow()] }); });
  await page.route(`**/api/v1/works/${workId}/subcontracts/payroll-export**`, async (route) => {
    requests.push(new URL(route.request().url()).searchParams);
    await route.fulfill({ body: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  const from = page.getByLabel('Nómina desde');
  const to = page.getByLabel('Nómina hasta');
  // Default: the current week, Monday to Sunday.
  const monday = await from.inputValue();
  const sunday = await to.inputValue();
  expect(new Date(`${monday}T12:00:00`).getDay()).toBe(1);
  expect((Date.parse(`${sunday}T12:00:00`) - Date.parse(`${monday}T12:00:00`)) / 86_400_000).toBe(6);
  const button = page.getByRole('button', { name: 'Exportar Nómina (Excel)' });
  let download = page.waitForEvent('download');
  await button.click();
  expect((await download).suggestedFilename()).toBe(`nomina-destajo-${monday}-${sunday}.xlsx`);
  expect(Object.fromEntries(requests[0]!)).toEqual({ from: monday, to: sunday });
  await from.fill('2026-09-01');
  await to.fill('2026-09-15');
  download = page.waitForEvent('download');
  await button.click();
  await download;
  expect(Object.fromEntries(requests[1]!)).toEqual({ from: '2026-09-01', to: '2026-09-15' });
  // An inverted range cannot be exported.
  await to.fill('2026-08-01');
  await expect(button).toBeDisabled();
});

test('Subcontratos: un error al exportar la nómina se explica', async ({ page }) => {
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [] }); });
  await page.route(`**/api/v1/works/${workId}/subcontracts/payroll-export**`, async (route) => {
    await route.fulfill({ status: 422, json: { detail: 'Rango de fechas inválido (máximo un año)' } });
  });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await page.getByRole('button', { name: 'Exportar Nómina (Excel)' }).click();
  await expect(page.locator('.notice.error')).toContainText('Rango de fechas inválido');
});

test('Subcontratos: devolución del fondo de garantía tras el finiquito, con tope del fondo retenido', async ({ page }) => {
  const posted: unknown[] = [];
  const settledEstimations = [
    estimationRow({ kind: 'avance', gross_amount: '4000.0000', retention_amount: '200.0000', net_amount: '3800.0000' }),
    estimationRow({ id: '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a', number: 2, folio: 'EST-02', kind: 'finiquito', gross_amount: '6000.0000', retention_amount: '300.0000', net_amount: '5700.0000' }),
  ];
  let estimations = settledEstimations;
  const settled = () => subcontractRow({ state: 'finiquitado', estimations, paid_net: '9500.0000', retained: '500.0000', retention_available: estimations.length > 2 ? '200.0000' : '500.0000', estimated_gross: '10000.0000', remaining_to_estimate: '0.0000' });
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [settled()] }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => { await route.fulfill({ json: settled() }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}/estimations`, async (route) => {
    const body = route.request().postDataJSON();
    posted.push(body);
    const saved = estimationRow({ id: '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b', number: 3, folio: 'EST-03', kind: 'devolucion_fondo', gross_amount: '300.0000', net_amount: '300.0000', state: 'borrador', paid_at: null, paid_by: null, adjustment_notes: body.adjustment_notes });
    estimations = [...settledEstimations, saved];
    await route.fulfill({ status: 201, json: saved });
  });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await page.getByRole('button', { name: 'Ver subcontrato SC-0001' }).click();
  // Settled: no new estimations except returning the retention fund.
  await expect(page.getByRole('button', { name: 'Nueva estimación' })).toHaveCount(0);
  await expect(page.getByTestId('sc-retained')).toHaveText('$500.00');
  await page.getByRole('button', { name: 'Devolver fondo de garantía' }).click();
  const form = page.getByRole('form', { name: 'Nueva estimación' });
  const kind = form.getByLabel('Tipo');
  await expect(kind).toHaveValue('devolucion_fondo');
  await expect(kind.locator('option[value="avance"]')).toHaveAttribute('disabled', '');
  // Only the amount to return and the notes are captured.
  await expect(form.getByLabel('Amortización de anticipo')).toHaveCount(0);
  await expect(form.getByLabel('Aditivas')).toHaveCount(0);
  await expect(form.getByLabel('Deductivas')).toHaveCount(0);
  await expect(form.getByTestId('refund-available')).toHaveText('Fondo disponible para devolver: $500.00');
  await expect(form.getByTestId('preview-retention')).toHaveCount(0);
  const save = form.getByRole('button', { name: 'Registrar estimación' });
  await form.getByLabel('Importe a devolver').fill('500.01');
  await expect(form.getByRole('alert')).toContainText('excede el fondo de garantía disponible');
  await expect(save).toBeDisabled();
  await form.getByLabel('Importe a devolver').fill('300');
  await expect(form.getByTestId('preview-net')).toHaveText('$300.00');
  await form.getByLabel('Notas', { exact: true }).fill('Fin del periodo de garantía');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Estimación EST-03 registrada como borrador.' })).toBeVisible();
  expect(posted).toEqual([{ estimated_on: expect.any(String), kind: 'devolucion_fondo', gross_amount: '300', advance_amortization: '0', additions: '0', deductions: '0', adjustment_notes: 'Fin del periodo de garantía' }]);
  // The refund draft can be paid although the contract is settled.
  const row = page.getByRole('table', { name: 'Historial de estimaciones de SC-0001' }).getByRole('row').filter({ hasText: 'EST-03' });
  await expect(row).toContainText('Devolución de fondo');
  await expect(row.getByRole('button', { name: 'Pagar estimación EST-03' })).toBeVisible();
  await expect(page.getByTestId('sc-retained')).toHaveText('$500.00');
  await expect(page.getByText('Devuelto $0.00 · disponible $200.00')).toBeVisible();
});

test('Subcontratos: en un contrato activo la devolución cuenta los borradores ya solicitados', async ({ page }) => {
  const estimations = [
    estimationRow({ kind: 'avance', gross_amount: '4000.0000', retention_amount: '200.0000', net_amount: '3800.0000' }),
    estimationRow({ id: '7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c', number: 2, folio: 'EST-02', kind: 'devolucion_fondo', gross_amount: '150.0000', net_amount: '150.0000', state: 'borrador', paid_at: null, paid_by: null }),
  ];
  await page.route(`**/api/v1/works/${workId}/subcontracts`, async (route) => { await route.fulfill({ json: [subcontractRow()] }); });
  await page.route(`**/api/v1/subcontracts/${subcontractId}`, async (route) => { await route.fulfill({ json: subcontractRow({ estimations, retained: '200.0000', retention_available: '50.0000' }) }); });
  await login(page);
  await page.goto(`/obras/${workId}/subcontratos`);
  await page.getByRole('button', { name: 'Ver subcontrato SC-0001' }).click();
  await page.getByRole('button', { name: 'Nueva estimación' }).click();
  const form = page.getByRole('form', { name: 'Nueva estimación' });
  await expect(form.getByLabel('Tipo')).toHaveValue('avance');
  await form.getByLabel('Aditivas').fill('10');
  await form.getByLabel('Tipo').selectOption('devolucion_fondo');
  await expect(form.getByLabel('Aditivas')).toHaveCount(0);
  await expect(form.getByTestId('refund-available')).toHaveText('Fondo disponible para devolver: $50.00');
  await form.getByLabel('Importe a devolver').fill('50');
  await expect(form.getByTestId('preview-net')).toHaveText('$50.00');
  await expect(form.getByRole('button', { name: 'Registrar estimación' })).toBeEnabled();
  await form.getByLabel('Importe a devolver').fill('50.01');
  await expect(form.getByRole('button', { name: 'Registrar estimación' })).toBeDisabled();
});
