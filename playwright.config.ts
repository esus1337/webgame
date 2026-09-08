import { defineConfig, devices } from '@playwright/test';

const PORT = 5178;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
