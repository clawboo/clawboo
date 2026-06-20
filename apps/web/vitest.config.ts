import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@': path.resolve(__dirname, 'src') }

// Two projects (vitest 3.x): the existing node-env suites (the React/SPA logic in
// src/ + the Express-server tests in server/, all `.test.ts`) and a jsdom project
// for React component tests (`.test.tsx`). Splitting by project keeps component
// tests from flipping the node-env server/store suites. One `vitest run` runs both.
export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
          environment: 'node',
          globals: true,
          // The server suite has real-git + real-sqlite integration tests that run
          // a few seconds each in isolation. When the jsdom project's heavier
          // component transforms run concurrently in the same `vitest run`, those
          // tests can be starved past the 5 s default — give them headroom (they
          // pass on their own merits; this only widens the tolerance, not results).
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'jsdom',
          include: ['src/**/*.test.tsx'],
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/__vitest__/setup.ts'],
          // jest-axe sweeps are CPU-heavy; under concurrent load with the node
          // project they can be starved past the 5 s default (a multi-card panel
          // axe pass that runs ~0.5 s in isolation can stretch well beyond it).
          // Widen the tolerance — same rationale as the node project above; this
          // changes timing headroom, not results.
          testTimeout: 15_000,
        },
      },
    ],
  },
})
