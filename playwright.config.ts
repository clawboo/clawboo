import { defineConfig, devices } from '@playwright/test'

// E2E tests pin the API port to a known value via CLAWBOO_API_PORT so they
// can talk to it directly (no port discovery needed). 19999 is well outside
// the regular auto-fallback window (18790-18809) so it never collides with
// a developer's running `pnpm dev` instance.
const API_PORT = parseInt(process.env.CLAWBOO_API_PORT ?? '19999', 10)
const API_BASE = `http://127.0.0.1:${API_PORT}`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: API_BASE,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `CLAWBOO_API_PORT=${API_PORT} pnpm --filter @clawboo/web build:ui && CLAWBOO_API_PORT=${API_PORT} pnpm --filter @clawboo/web start`,
    url: `${API_BASE}/api/settings`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
