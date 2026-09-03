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
    expect(route.request().method()).toBe('DELETE');
    expect(route.request().postDataJSON()).toEqual({ confirmation_name: 'Infra Toluca' });
    workDeleted = true;
    await route.fulfill({
      json: { id: workId, nombre: 'Infra Toluca', deleted: true, counts: {}, receipt_paths: [] },
    });
  });
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    await route.fulfill({
      json: {
        areas: [{ id: areaId, nombre: 'Oficina' }],
        items: [{ budget_item_id: budgetItemId, area_id: areaId, codigo: 'ALB-05', descripcion: 'Firme de concreto', clase: 'ALBAÑILERÍAS' }],
        expense_partidas: [{ id: expensePartidaId, nombre: 'PRELIMINARES' }, { id: secondExpensePartidaId, nombre: 'ALBANILERIA' }],
        expense_subitems: [{ id: expenseSubpartidaId, partida_id: expensePartidaId, nombre: 'LIMPIEZA' }, { id: secondExpenseSubpartidaId, partida_id: secondExpensePartidaId, nombre: 'FIRMES Y HORMIGONES' }],
        expense_categories: [{ id: expenseCategoryId, nombre: 'MATERIAL' }],
        suppliers: [],
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
      supplier_name: 'Concretos Toluca',
    });
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await page.route('**/api/v1/weekly-closes', async (route) => {
    await route.fulfill({ status: 201, json: { expense_count: 12 } });
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

test('captura gasto y comprobante queda pendiente', async ({ page }) => {
  await login(page);
  await page.goto('/gastos');
  const partida = page.getByLabel('Partida', { exact: true });
  const subpartida = page.getByLabel('Subpartida', { exact: true });
  await expect(partida).toBeEnabled();
  await expect(partida).toHaveValue(expensePartidaId);
  await expect(subpartida).toHaveValue(expenseSubpartidaId);
  await partida.selectOption(secondExpensePartidaId);
  await expect(subpartida).toHaveValue(secondExpenseSubpartidaId);
  await expect(page.getByLabel('Categoría', { exact: true })).toHaveValue(expenseCategoryId);
  await page.getByLabel('Proveedor', { exact: true }).fill('Concretos Toluca');
  await page.getByLabel('Importe').fill('18450');
  await page.getByLabel('Concepto').fill('Cemento y adhesivo para firme de oficina');
  await page.getByRole('button', { name: /Guardar pendiente/ }).click();
  await expect(page.getByRole('status')).toContainText('Gasto guardado como pendiente');
});

test('cierre semanal crea evidencia de lote', async ({ page }) => {
  await login(page);
  await page.goto('/cierres');
  await page.getByRole('button', { name: 'Cerrar semana 35' }).click();
  await expect(page.getByRole('status')).toContainText('Cierre confirmado');
  await expect(page.getByText('Semana cerrada')).toBeVisible();
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
