import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // These suites are deterministic + network-free but genuinely slow: each
    // trial spins up a fresh temp-SQLite board with full DDL bootstrap (the
    // smoke suite runs 7 tasks x 3 trials; the ablation runs 4 flag configs).
    // Locally that lands ~5-8s; a slower CI runner pushes past vitest's 5s
    // default and times out. Match the apps/web node-project headroom (30s).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
