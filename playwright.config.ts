import { defineConfig } from '@playwright/test'

// E2E: браузер -> rivetd -> Postgres. Стенд поднимает scripts/e2e-stand.sh
// из rivet-service: чистая база, fake SCM, fake-агенты, локальный git.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:8281',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'sh ../rivet-service/scripts/e2e-stand.sh',
    url: 'http://localhost:8281/api/v1/projects',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
