import { type Locator, type Page, expect, test } from '@playwright/test';

const WORK_ID = process.env.D89_LIVE_WORK_ID ?? 'c6e944fc-1e29-4623-a8a9-33f4bfdb1bc4';
const MARK = 'PRUEBA AUTOMATIZADA Playwright';

test.skip(!process.env.D89_LIVE_EMAIL || !process.env.D89_LIVE_PASSWORD, 'Requiere D89_LIVE_EMAIL y D89_LIVE_PASSWORD');

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(process.env.D89_LIVE_EMAIL!);
  await page.getByLabel('Contraseña').fill(process.env.D89_LIVE_PASSWORD!);
  await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
  await expect(page.getByRole('heading', { name: 'Panorama de obra' })).toBeVisible();
}

async function shot(page: Page, name: string) {
  await test.info().attach(name, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
}

async function fillLine(form: Locator, n: number, values: { quantity: string; unit: string; description: string; price: string; taxable?: boolean }) {
  if (n > 1) await form.getByRole('button', { name: '+ Agregar concepto' }).click();
  await form.getByLabel(`Cantidad concepto ${n}`).fill(values.quantity);
  await form.getByLabel(`Unidad concepto ${n}`).fill(values.unit);
  await form.getByLabel(`Descripción concepto ${n}`).fill(values.description);
  await form.getByLabel(`Precio unitario concepto ${n}`).fill(values.price);
  if (values.taxable === false) await form.getByLabel(`IVA concepto ${n}`).uncheck();
}

/** Test CFDI 4.0 (not stamped, fictitious RFC) dated today so the week is open. */
function testCfdi(folio: string): Buffer {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const tax = (base: string, amount: string) =>
    `<cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="${base}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="${amount}"/></cfdi:Traslados></cfdi:Impuestos>`;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="PW" Folio="${folio}" Fecha="${today}T10:00:00" SubTotal="1250.50" Moneda="MXN" Total="1450.58" TipoDeComprobante="I">
  <cfdi:Emisor Rfc="PWT990101AB1" Nombre="PROVEEDOR PRUEBA PLAYWRIGHT" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="D89"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="30111601" Cantidad="10" ClaveUnidad="H87" Descripcion="Cemento gris (prueba)" ValorUnitario="100" Importe="1000" ObjetoImp="02">${tax('1000', '160')}</cfdi:Concepto>
    <cfdi:Concepto ClaveProdServ="78101802" Cantidad="1" ClaveUnidad="E48" Descripcion="Flete (prueba)" ValorUnitario="250.50" Importe="250.50" ObjetoImp="02">${tax('250.50', '40.08')}</cfdi:Concepto>
  </cfdi:Conceptos>
</cfdi:Comprobante>`);
}

test('en vivo: login y navegación de secciones', async ({ page }) => {
  await login(page);
  await shot(page, 'panorama');
  for (const [path, heading] of [['/proveedores', 'Directorio de proveedores'], ['/cierres', 'Cierre semanal'], ['/gastos', 'Nuevo gasto']] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    await shot(page, path.slice(1));
  }
  // The expense form renders the new header-detail editor and multi-receipt dropzone.
  const form = page.locator('form.work-expense-form');
  await expect(form.getByLabel('Cantidad concepto 1')).toBeVisible();
  await expect(form.getByLabel('Comprobantes', { exact: true })).toBeAttached();
});

test('en vivo: multi-concepto, CFDI XML, alta rápida (cancelada), guardar, editar y cancelar el gasto de prueba', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Crea datos: sólo una vez, en escritorio');
  const runId = String(Date.now()).slice(-6);
  await login(page);
  await page.goto(`/obras/${WORK_ID}/gastos`);
  await page.getByRole('button', { name: 'Nuevo gasto', exact: true }).click();
  const form = page.locator('form.work-expense-form');

  // 1. Multi-concept with live totals: IVA only on the taxable line (16 % incluido).
  await fillLine(form, 1, { quantity: '10', unit: 'bulto', description: `${MARK} cemento`, price: '100' });
  await fillLine(form, 2, { quantity: '1', unit: 'pieza', description: `${MARK} exento`, price: '50', taxable: false });
  await expect(form.getByTestId('expense-total')).toHaveText('$1,050.00');
  await expect(form.getByTestId('expense-iva')).toHaveText('$137.93'); // 1000 − 1000/1.16
  await expect(form.getByTestId('expense-subtotal')).toHaveText('$912.07');
  await shot(page, 'multi-concepto');

  // 2. Quick supplier modal opens (with CSF autofill) and is cancelled: nothing is created.
  const supplier = form.getByLabel('Proveedor', { exact: true });
  const selectedSupplier = await supplier.inputValue();
  await supplier.selectOption({ label: '+ Nuevo proveedor' });
  const dialog = page.getByRole('dialog', { name: 'Alta de proveedor' });
  await expect(dialog.getByLabel('Auto-rellenar desde Constancia (PDF)')).toBeAttached();
  await shot(page, 'alta-rapida-proveedor');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(supplier).toHaveValue(selectedSupplier);

  // 3. Real CFDI read by the deployed API (no AI), plus a PDF receipt.
  await form.getByLabel('Concepto general').fill(`${MARK} ${runId} — se cancela al terminar`);
  await form.getByLabel('Comprobantes', { exact: true }).setInputFiles([
    { name: `cfdi-prueba-${runId}.xml`, mimeType: 'text/xml', buffer: testCfdi(runId) },
    { name: `factura-prueba-${runId}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%prueba playwright\n%%EOF') },
  ]);
  const summary = form.getByRole('region', { name: 'Datos del CFDI' });
  await expect(summary).toContainText('PROVEEDOR PRUEBA PLAYWRIGHT');
  await expect(summary).toContainText('$1,450.58');
  await expect(summary).toContainText('no es un CFDI timbrado'); // expected warning for a test XML
  await shot(page, 'cfdi-leido');
  await summary.getByRole('button', { name: 'Usar datos del CFDI' }).click();
  await expect(form.getByLabel('Descripción concepto 1')).toHaveValue('Cemento gris (prueba)');
  await expect(form.getByTestId('expense-total')).toHaveText('$1,450.58');
  await expect(form.getByTestId('expense-iva')).toHaveText('$200.08');
  await expect(form.getByLabel('Folio del proveedor')).toHaveValue(`PW-${runId}`);

  // 4. Save for real: header + lines, then both files uploaded and linked.
  await form.getByRole('button', { name: 'Guardar pendiente' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Gasto guardado como pendiente' })).toBeVisible();
  await expect(form).toHaveCount(0);

  // 5. It appears in the list with an automatic folio and the supplier folio.
  await page.getByLabel('Buscar gastos').fill(`PW-${runId}`);
  const row = page.locator('tr', { hasText: `PW-${runId}` });
  await expect(row).toHaveCount(1);
  const folio = (await row.locator('small').first().textContent())?.match(/G-\d{5,}/)?.[0];
  expect(folio, 'folio automático').toBeTruthy();
  await testInfo.attach('folio', { body: folio!, contentType: 'text/plain' });
  await shot(page, 'listado-con-folio');

  // 6. Edit loads the saved lines and both receipts from GET /expenses/{id}.
  await row.getByRole('button', { name: 'Editar', exact: true }).click();
  const edit = page.locator('form.work-expense-form');
  await expect(edit.getByRole('heading', { name: `Corregir gasto ${folio}` })).toBeVisible();
  await expect(edit.getByLabel('Descripción concepto 2')).toHaveValue('Flete (prueba)');
  await expect(edit.getByTestId('expense-total')).toHaveText('$1,450.58');
  await expect(edit.getByText('Ya vinculado')).toHaveCount(2);
  await shot(page, 'edicion-detalle');
  await edit.getByRole('button', { name: 'Cancelar', exact: true }).click();

  // 7. Clean up: cancel the test expense (soft delete kept in the audit log).
  page.once('dialog', (prompt) => void prompt.accept(`Prueba automatizada Playwright ${runId}: limpieza`));
  await row.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByText('Gasto cancelado y conservado en auditoría.')).toBeVisible();
  await expect(page.locator('tr', { hasText: `PW-${runId}` })).toHaveCount(0);
  await shot(page, 'gasto-cancelado');
});
