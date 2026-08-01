import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Electron 实例启动开销大，且共享同一份用户数据目录，串行跑最稳
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
  },
})
