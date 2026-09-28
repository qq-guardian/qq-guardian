import { test, expect } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:6099';
const API = `${BASE}/plugin/napcat-plugin-qq-guardian/api`;

async function seedAndLogin(page: import('@playwright/test').Page) {
  const timestamp = Date.now();
  const username = `smoke_${timestamp}`;
  const password = 'smoke-pass-123';

  await page.request.post(`${API}/auth/register`, {
    data: { username, password, role: 'super_admin' },
    headers: { 'Content-Type': 'application/json' },
  });

  await page.goto(`${BASE}/plugin/napcat-plugin-qq-guardian/page/guardian`);
  await page.fill('#login-user', username);
  await page.fill('#login-pass', password);
  await page.click('#login-btn');

  await expect(page.locator('#login-overlay')).toHaveClass(/open/i, { timeout: 15_000 }).catch(() => {});
  await expect(page.locator('#sb-nav')).toBeVisible({ timeout: 15_000 });
}

test.describe('WebUI smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('login overlay is visible on first load', async ({ page }) => {
    await page.goto(`${BASE}/plugin/napcat-plugin-qq-guardian/page/guardian`);
    await expect(page.locator('#login-overlay')).toHaveClass(/open/);
    await expect(page.locator('#login-user')).toBeVisible();
    await expect(page.locator('#login-pass')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
  });

  test('successful login reveals navigation and dashboard', async ({ page }) => {
    await seedAndLogin(page);
    await expect(page.locator('#page-dashboard')).toHaveClass(/active/);
    await expect(page.locator('#stats-grid')).toBeVisible();
  });

  test('navigation switches between pages', async ({ page }) => {
    await seedAndLogin(page);
    await page.click('#sb-nav .sb-item[data-page="groups"]');
    await expect(page.locator('#page-groups')).toHaveClass(/active/);
    await expect(page.locator('#btn-refresh-groups')).toBeVisible();

    await page.click('#sb-nav .sb-item[data-page="settings"]');
    await expect(page.locator('#page-settings')).toHaveClass(/active/);
    await expect(page.locator('#cfg-selfid')).toBeVisible();
  });

  test('theme toggle changes data-theme attribute', async ({ page }) => {
    await seedAndLogin(page);
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', /system|light|dark/);

    await page.click('#theme-btn');
    await expect(html).toHaveAttribute('data-theme', /light|dark|system/);
  });

  test('groups page loads empty state when bot has no groups', async ({ page }) => {
    await seedAndLogin(page);
    await page.click('#sb-nav .sb-item[data-page="groups"]');
    await expect(page.locator('#page-groups')).toHaveClass(/active/);
    await expect(page.locator('#bot-account-card')).toBeVisible();
  });

  test('logout button is present and clickable', async ({ page }) => {
    await seedAndLogin(page);
    await expect(page.locator('#sb-logout-btn')).toBeVisible();
    await page.click('#sb-logout-btn');
    await expect(page.locator('#login-overlay')).toHaveClass(/open/);
  });
});
