const { test, expect } = require('@playwright/test');

test('Argus avatar-first flow', async ({ page }) => {
  const errors = [];
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) errors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  await page.goto('http://127.0.0.1:3003', { waitUntil: 'networkidle' });
  await expect(page.locator('.avatar-gate')).toBeVisible();
  await expect(page.locator('.avatar-start')).toBeVisible();
  await expect(page.locator('.post-agent-shell')).toHaveCount(0);
  await expect(page.locator('.mapbox-stage')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/argus-avatar-start.png', fullPage: false });

  await page.getByRole('button', { name: /Iniciar agente/i }).click();
  await expect(page.locator('.avatar-gate-video')).toBeVisible();
  await expect(page.locator('.avatar-gate-controls')).toBeVisible();
  await expect(page.locator('.post-agent-shell')).toHaveCount(0);
  await expect(page.locator('.mapbox-stage')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/argus-avatar-active.png', fullPage: false });

  console.log(JSON.stringify({ errors: errors.slice(0, 10) }, null, 2));
});
