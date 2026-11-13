import { defineConfig } from '@playwright/test';
import { STAND } from './e2e/stand';
export default defineConfig({ testDir: './e2e', testMatch: 'workspaces.spec.ts', workers: 1, retries: 0, timeout: 120000, expect: { timeout: 15000 }, use: { baseURL: `http://127.0.0.1:${STAND.httpPort}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
