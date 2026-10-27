import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { api, ensureBackend, env, openApp } from './support/app.mjs';

let app;
let stopBackend;
before(async () => { stopBackend = await ensureBackend(); app = await openApp(); });
after(async () => {
  try {
    const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
    const response = await fetch(`${env.api}/api/settings/language`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ value: 'en' }) });
    assert.ok(response.ok);
  } finally {
    try { await app?.close(); } finally { await stopBackend?.(); }
  }
});

it('defaults to English, switches the open interface to German, and restores the choice after reload', async () => {
  const { page, h } = app;
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  const dialog = await h.openSettings('General');
  const selector = dialog.getByTestId('language-select');
  assert.equal(await selector.inputValue(), 'en');
  await dialog.getByText('Interface language', { exact: true }).waitFor();
  const out = join(process.cwd(), 'output/playwright/i18n');
  mkdirSync(out, { recursive: true });
  await h.theme('pi-dark');
  await page.screenshot({ path: join(out, 'settings-en.png') });

  const saved = page.waitForResponse((response) => response.url().endsWith('/api/settings/language') && response.request().method() === 'PUT');
  await selector.selectOption('de');
  assert.ok((await saved).ok());
  const german = page.getByRole('dialog', { name: 'Einstellungen', exact: true });
  await german.getByText('Sprache der Oberfläche', { exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  assert.equal((await api('/api/settings')).language, 'de');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-kit.look')).language), 'de');
  const search = german.getByRole('searchbox');
  await search.fill('Sprache Oberfläche');
  await german.locator('[data-setting="language"]').waitFor();
  await search.fill('');
  await page.reload();
  await page.locator('html[lang="de"]').waitFor();
  await page.getByTestId('settings-button').click();
  const restored = page.getByRole('dialog', { name: 'Einstellungen', exact: true });
  await restored.getByText('Sprache der Oberfläche', { exact: true }).waitFor();
  assert.equal(await restored.getByTestId('language-select').inputValue(), 'de');
  await h.theme('pi-dark');
  await page.screenshot({ path: join(out, 'settings-de.png') });
  assert.deepEqual(app.errors, []);
});
