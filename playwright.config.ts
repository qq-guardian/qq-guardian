import { defineConfig, devices } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '6099';
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/webui',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  ...(process.env.PLAYWRIGHT_BASE_URL ? {} : {
    webServer: {
      command: 'pnpm run build && node scripts/webui-smoke-server.mjs',
      url: `http://127.0.0.1:${port}/__health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
