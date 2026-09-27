import { expect, test } from '@playwright/test';

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
    } });
  });
  await page.route(`**/api/v1/works/${workId}/expenses**`, async (route) => {
    await route.fulfill({ json: { items: [{ id: '44444444-4444-4444-8444-444444444444', area_id: areaId, expense_item_id: expensePartidaId, expense_subitem_id: expenseSubpartidaId, expense_category_id: expenseCategoryId, supplier_id: 'abababab-abab-4bab-8bab-abababababab', proveedor: 'Concretos Toluca', budget_item_id: budgetItemId, fecha: '2026-08-28', concepto: 'Cemento y adhesivo', folio: 'A-1', importe: '4150', comprobante_path: 'receipt.pdf', estado: 'pendiente', area: 'Oficina', area_ruta: ['OFICINA'], partida: 'PRELIMINARES', subpartida: 'LIMPIEZA', categoria: 'MATERIAL', autor: 'Sergio Gómez', motivo_revision: null, creado_por: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expense_locked: false, can_edit: true, can_cancel: true, can_resubmit: false }], total: 1, page: 1, page_size: 50 } });
  });
  await page.route(`**/api/v1/works/${workId}/weekly-closes`, async (route) => {
    await route.fulfill({ json: [] });
  });
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    await route.fulfill({
      json: {
        areas: [{ id: areaId, nombre: 'Oficina', ruta: ['OFICINA'], nivel: 0, seleccionable: true }],
        items: [{ budget_item_id: budgetItemId, area_id: areaId, codigo: 'ALB-05', descripcion: 'Firme de concreto', clase: 'ALBAÑILERÍAS' }],
        expense_partidas: [{ id: expensePartidaId, nombre: 'PRELIMINARES' }, { id: secondExpensePartidaId, nombre: 'ALBANILERIA' }],
        expense_subitems: [{ id: expenseSubpartidaId, partida_id: expensePartidaId, nombre: 'LIMPIEZA' }, { id: secondExpenseSubpartidaId, partida_id: secondExpensePartidaId, nombre: 'FIRMES Y HORMIGONES' }],
        expense_categories: [{ id: expenseCategoryId, nombre: 'MATERIAL' }],
        suppliers: [{ id: supplierId, nombre: 'Concretos Toluca' }],
      },
    });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    const payload = route.request().postDataJSON();
    expect(payload).toMatchObject({
      work_id: workId,
      area_id: areaId,
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
      expenses: [{ id: '44444444-4444-4444-8444-444444444444', obra_id: workId, obra: 'Infra Toluca', fecha: '2026-08-28', concepto: 'Cemento y adhesivo', folio: 'A-1', importe: '18450', estado: 'validado' }],
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

test('/gastos usa el formulario unificado y no duplica el gasto al reintentar la subida', async ({ page }) => {
  const expenseId = '44444444-4444-4444-8444-444444444444';
  const payloads: Record<string, unknown>[] = [];
  let uploads = 0;
  let links = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    payloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: expenseId } });
  });
  await page.route('**/storage/v1/object/comprobantes/**', async (route) => {
    uploads += 1;
    if (uploads === 1) await route.fulfill({ status: 500, json: { message: 'Fallo simulado de subida' } });
    else await route.fulfill({ json: { Key: 'comprobantes/receipt.png' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}/receipt`, async (route) => {
    links += 1;
    await route.fulfill({ json: { id: expenseId } });
  });

  await login(page);
  await page.goto('/gastos');
  const form = page.locator('form.work-expense-form');
  await expect(form.getByLabel('Buscar área NEODATA')).toBeVisible();
  await expect(form.getByLabel('Partida NEODATA')).toBeVisible();
  const partida = form.getByLabel('Partida', { exact: true });
  const subpartida = form.getByLabel('Subpartida', { exact: true });
  await expect(partida).toHaveValue(expensePartidaId);
  await partida.selectOption(secondExpensePartidaId);
  await expect(subpartida).toHaveValue(secondExpenseSubpartidaId);
  await form.getByLabel('Importe').fill('18450');
  await form.getByLabel('Concepto').fill('Cemento y adhesivo para firme de oficina');
  await form.getByLabel('Comprobante').setInputFiles({
    name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('test-image'),
  });
  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(form.getByRole('alert')).toContainText('Reintenta sólo el comprobante');
  await form.getByRole('button', { name: 'Reintentar comprobante' }).click();
  await expect(page.getByRole('status')).toContainText('Gasto guardado como pendiente');
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ work_id: workId, expense_item_id: secondExpensePartidaId });
  expect(payloads[0]).not.toHaveProperty('state');
  expect(uploads).toBe(2);
  expect(links).toBe(1);
  await expect(form.getByLabel('Importe')).toBeEmpty();
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
    await form.getByLabel('Importe').fill('321.00');
    await form.getByLabel('Concepto').fill('Gasto que sólo debe crearse una vez');
    await form.getByLabel('Comprobante').setInputFiles({
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
      await expect(form.getByLabel('Importe')).toBeDisabled();
      await expect(form.getByLabel('Comprobante')).toBeDisabled();
    } finally {
      releaseCreation();
    }
    await expect(form.getByRole('alert')).toContainText('El gasto ya está guardado');
    await expect(form.getByRole('alert')).toContainText('Reintenta sólo el comprobante');
    await expect(form.getByLabel('Importe')).toHaveValue('321.00');
    await expect(form.getByLabel('Concepto')).toHaveValue('Gasto que sólo debe crearse una vez');
    await expect(form.getByLabel('Importe')).toBeDisabled();
    expect(creations).toBe(1);
    if (failure === 'link') {
      await expect(form.getByLabel('Comprobante')).toBeDisabled();
    } else {
      await expect(form.getByLabel('Comprobante')).toBeEnabled();
      // Clearing the file cannot silently finish a partially saved operation.
      await form.getByLabel('Comprobante').setInputFiles([]);
      await form.getByRole('button', { name: 'Reintentar comprobante' }).click();
      await expect(form).toBeVisible();
      expect(uploads).toBe(1);
      await form.getByLabel('Comprobante').setInputFiles({
        name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('test-image'),
      });
    }
    await form.getByRole('button', { name: 'Reintentar comprobante' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('Gasto guardado como pendiente');
    expect(creations).toBe(1);
    expect(uploads).toBe(failure === 'upload' ? 2 : 1);
    expect(links).toBe(failure === 'link' ? 2 : 1);
    expect(new Set(linkedPaths).size).toBe(1);
    expect(linkedPaths[0]).toContain(`/${expenseId}/`);
    await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
    await expect(form.getByLabel('Importe')).toBeEmpty();
    await expect(form.getByLabel('Concepto')).toBeEmpty();
    await form.getByLabel('Importe').fill('99');
    await form.getByLabel('Concepto').fill('Otro gasto intencional');
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
  await form.getByLabel('Importe').fill('100');
  await form.getByLabel('Concepto').fill('Intento no guardado');
  await form.getByRole('button', { name: 'Guardar pendiente' }).click();
  await expect(form.getByRole('alert')).toHaveText('Alta no disponible');
  await expect(form.getByLabel('Importe')).toBeEnabled();
  await expect(form.getByLabel('Importe')).toHaveValue('100');
  await form.getByRole('button', { name: 'Guardar pendiente' }).click();
  await expect(form).toHaveCount(0);
  expect(creations).toBe(2);
});

test('gasto: corregir y reintentar comprobante no repite la edición ni crea otro gasto', async ({ page }) => {
  const expenseId = '44444444-4444-4444-8444-444444444444';
  let updates = 0;
  let creations = 0;
  let uploads = 0;
  await page.route('**/api/v1/expenses', async (route) => {
    creations += 1;
    await route.fulfill({ status: 500, json: { detail: 'No debe crear al editar' } });
  });
  await page.route(`**/api/v1/expenses/${expenseId}`, async (route) => {
    expect(route.request().method()).toBe('PATCH');
    updates += 1;
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
  await form.getByLabel('Concepto').fill('Concepto corregido');
  await form.getByLabel('Comprobante').setInputFiles({
    name: 'receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-test'),
  });
  await form.getByRole('button', { name: 'Guardar corrección' }).click();
  await expect(form.getByRole('alert')).toContainText('El gasto ya está guardado');
  await expect(form.getByLabel('Concepto')).toHaveValue('Concepto corregido');
  await form.getByRole('button', { name: 'Reintentar comprobante' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Gasto corregido correctamente');
  expect(updates).toBe(1);
  expect(uploads).toBe(2);
  expect(creations).toBe(0);
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
  await expect(form.getByText('Se adjuntará la foto del ticket (ticket.jpg)')).toBeVisible();

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
  await expect(save).toBeEnabled();

  await assistant.getByRole('button', { name: 'Usar en el formulario' }).click();
  await expect(form.getByLabel('Importe')).toHaveValue('1250.50');
  await expect(form.getByLabel('Concepto')).toHaveValue('10 × Cemento gris 50 kg; 1 × Pintura vinílica');
  // Manual fallback: the regular fields stay editable after applying Jev's result.
  await form.getByLabel('Concepto').fill('Cemento y pintura para oficina');
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
  await expect(form.getByLabel('Concepto')).toHaveValue('Cemento y pintura para oficina');
  await save.click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Gasto guardado como pendiente');
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ work_id: workId, amount: '1250.50', concept: 'Cemento y pintura para oficina' });
  expect(created[0]).not.toHaveProperty('state');
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toContain(`/${workId}/${expenseId}/`);
  expect(uploads[0]).toMatch(/ticket\.jpg$/);
  expect(links).toHaveLength(1);
  expect(links[0]).toMatch(new RegExp(`^${workId}/${expenseId}/\\d+-ticket\\.jpg$`));
});

test('Jev: si la IA está caída se captura a mano y un comprobante elegido reemplaza la foto', async ({ page }) => {
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
  await form.getByLabel('Foto del ticket o nota de remisión').setInputFiles({
    name: 'ticket.png', mimeType: 'image/png', buffer: Buffer.from('png'),
  });
  const alert = form.getByRole('alert');
  await expect(alert).toContainText('El servicio de IA no está disponible');
  await expect(alert).toContainText('Puedes capturar los datos manualmente');
  await expect(form.getByLabel('Corrección para Jev')).toHaveCount(0);
  await form.getByLabel('Importe').fill('80');
  await form.getByLabel('Concepto').fill('Clavos, capturado a mano');
  await form.getByLabel('Comprobante').setInputFiles({
    name: 'factura.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7'),
  });
  await form.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(page.getByRole('status')).toContainText('Gasto guardado como pendiente');
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
  await form.getByLabel('Foto del ticket o nota de remisión').setInputFiles({
    name: 'ticket.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a'),
  });
  await expect(form.getByRole('alert')).toContainText('JPEG, PNG o WebP');
  await expect(form.getByText(/Se adjuntará la foto del ticket/)).toHaveCount(0);
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
