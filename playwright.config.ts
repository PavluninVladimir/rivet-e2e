import { defineConfig } from '@playwright/test'
import { STAND, STAND_ENV } from './e2e/stand'

// E2E: браузер -> rivetd -> Postgres. Стенд поднимает scripts/e2e-stand.sh
// из rivet-service: чистая база, fake SCM, runner'ы агента Rivet поверх
// fake-llm, локальный git.
// Порты и каталог стенда — e2e/stand.ts: E2E_HTTP_PORT, E2E_GRPC_PORT,
// E2E_LLM_PORT, E2E_STAND_DIR (остальные выводятся из E2E_HTTP_PORT), чтобы
// прогон можно было поднять рядом с другими стендами.

// process.env без пустых значений: окружение команды стенда целиком плюс
// вычисленные порты.
const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${STAND.httpPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'sh ../rivet-service/scripts/e2e-stand.sh',
    url: `http://localhost:${STAND.httpPort}/api/v1/projects`,
    env: { ...env, ...STAND_ENV },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
