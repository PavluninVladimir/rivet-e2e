import { defineConfig } from '@playwright/test'

// E2E: браузер -> rivetd -> Postgres. Стенд поднимает scripts/e2e-stand.sh
// из rivet-service: чистая база, fake SCM, fake-агенты, локальный git.
// Порт стенда задаёт E2E_HTTP_PORT, тот же, что читает e2e-stand.sh: так
// несколько стендов уживаются на одной машине.
const port = process.env.E2E_HTTP_PORT ?? '8281'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'sh ../rivet-service/scripts/e2e-stand.sh',
    url: `http://localhost:${port}/api/v1/projects`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
