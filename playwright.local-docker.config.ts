import { defineConfig } from '@playwright/test'
export default defineConfig({
 testDir:'./e2e',testMatch:'local-docker.spec.ts',workers:1,retries:0,timeout:300_000,
 expect:{timeout:30_000},use:{trace:'retain-on-failure',screenshot:'only-on-failure'},
})
