import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // ONLY the pure packages run under this root config. apps/web has its own
    // two-project vitest config (a node project for `.test.ts` + a jsdom project
    // for `.test.tsx`, with the aliases / timeouts / setup it needs); a bare root
    // `vitest` would mis-run apps/web suites in this plain node env, so they're
    // excluded here. `pnpm test` goes through turbo → per-package configs (the
    // real path); this root config is only for ad-hoc package runs.
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
})
