import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = { '@': path.resolve(__dirname, 'src') }

// The node project's server suites drive a real `git` binary, real SQLite, and real
// child processes, so their wall-clock is dominated by the host's I/O and process
// spawn cost rather than by our code. GitHub's windows-latest runners are about
// twice as slow as macOS for this same suite (measured 6m57s against 3m45s on a
// green run), and some of that work shells out to PowerShell, where a single
// Get-CimInstance probe can cost seconds. A 30s budget tuned on Linux therefore
// reads as a timeout on Windows for tests that are merely slow, not broken. Widen
// the tolerance on that platform only. This is a tolerance, not a fix: a test that
// fails here for a genuine race should be fixed rather than given more seconds.
const SERVER_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000

// Two projects (vitest 3.x): the existing node-env suites (the React/SPA logic in
// src/ + the Express-server tests in server/, all `.test.ts`) and a jsdom project
// for React component tests (`.test.tsx`). Splitting by project keeps component
// tests from flipping the node-env server/store suites. One `vitest run` runs both.
export default defineConfig({
  test: {
    globals: true,
    // Bound the TOTAL worker pool. Vitest runs the two projects below
    // CONCURRENTLY, and each one sizes its own pool to the full CPU count — so
    // the default is ~2x cores of workers fighting over the machine. The
    // jsdom project's transforms (framer-motion / React Flow / jest-axe) are
    // CPU-bound, so that over-subscription starves whole files past their
    // timeout: on an 8-core box the suite took ~42 min with 18-62 spurious
    // "Test timed out" failures, and 48 s with ZERO at 50%. The failures were
    // never real — every one of those files passes on its own.
    //
    // This is the actual fix for that starvation; the widened per-project
    // timeouts below are the older, blunter mitigation for the same cause.
    maxWorkers: '50%',
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
          environment: 'node',
          globals: true,
          // A spy that outlives its test poisons the next one. Vitest abandons a
          // timed-out test where it stands, so a `finally { spy.mockRestore() }`
          // in the test body never runs in time. The widened timeout below exists
          // because starvation timeouts are an expected failure mode here, which
          // is exactly when that cleanup is skipped. Restoring before each test
          // keeps one timeout to one failure instead of a cascade.
          //
          // This has to sit on the PROJECT, not the root `test` block: an inline
          // project resolves to `{...options.test, ...cliOverrides}`, so nothing
          // from the root block reaches it. That is also why `globals` repeats.
          restoreMocks: true,
          // Makes `$HOME` authoritative for `os.homedir()` on every platform, so the
          // suites that sandbox `process.env.HOME` actually land in their temp dir on
          // Windows too (Node reads %USERPROFILE% there). A no-op on POSIX. See the
          // file's header for why this is one seam rather than an env var per suite.
          setupFiles: ['./server/__vitest__/setupHomedir.ts'],
          // The server suite has real-git + real-sqlite integration tests that run
          // a few seconds each in isolation. When the jsdom project's heavier
          // component transforms run concurrently in the same `vitest run`, those
          // tests can be starved past the 5 s default — give them headroom (they
          // pass on their own merits; this only widens the tolerance, not results).
          testTimeout: SERVER_TIMEOUT_MS,
          hookTimeout: SERVER_TIMEOUT_MS,
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
          // Same hazard as the node project above.
          restoreMocks: true,
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
