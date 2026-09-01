import { expect, test } from '@playwright/test';

const workId = '11111111-1111-4111-8111-111111111111';
const areaId = '22222222-2222-4222-8222-222222222222';
const budgetItemId = '33333333-3333-4333-8333-333333333333';

test.beforeEach(async ({ page }) => {
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
        works: [{ id: workId, nombre: 'Infra Toluca', ubicacion: 'Toluca', presupuesto: '2624832.88', gasto: '18450', pendiente: '18450', cobrado: '75000', por_cobrar: '0', subcontratado: '45000', pagado_subcontratos: '18450' }],
        totals: { budget: '2624832.88', spent: '18450', available: '2606382.88', pending: '18450', collected: '75000', receivable: '0', subcontracted: '45000', subcontract_paid: '18450', cash_balance: '56550' },
      },
    });
  });
  await page.route('**/api/v1/works/*/catalog', async (route) => {
    await route.fulfill({
      json: {
        areas: [{ id: areaId, nombre: 'Oficina' }],
        items: [{ budget_item_id: budgetItemId, area_id: areaId, codigo: 'ALB-05', descripcion: 'Firme de concreto', clase: 'ALBAÑILERÍAS' }],
        suppliers: [],
      },
    });
  });
  await page.route('**/api/v1/expenses', async (route) => {
    await route.fulfill({ status: 201, json: { id: '44444444-4444-4444-8444-444444444444' } });
  });
  await page.route('**/api/v1/weekly-closes', async (route) => {
    await route.fulfill({ status: 201, json: { expense_count: 12 } });
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

test('portal admin prepara preview NEODATA sin confirmar', async ({ page }) => {
  await login(page);
  await page.goto('/admin/importar');
  await expect(page.getByRole('heading', { name: 'Importar presupuesto' })).toBeVisible();
  await expect(page.getByText('Sin escritura todavía.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generar preview' })).toBeDisabled();
});

test('captura gasto y comprobante queda pendiente', async ({ page }) => {
  await login(page);
  await page.goto('/gastos');
  await expect(page.getByLabel('Partida')).toBeEnabled();
  await page.getByLabel('Partida').selectOption(budgetItemId);
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
