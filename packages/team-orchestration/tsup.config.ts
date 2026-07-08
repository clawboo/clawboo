import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the pure engine barrel (browser-safe, no test deps) and the
  // cascade-invariant CONTRACT (imports vitest — exposed under `./contract` so app
  // consumers of the main barrel never pull a test runner in). Named entries → flat
  // dist names (index.js / contract.js). The engine is self-contained except the two
  // workspace deps (@clawboo/executor types, @clawboo/governance's checkFanoutCap),
  // which the consuming app/server bundles.
  entry: { index: 'src/index.ts', contract: 'src/contract.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the test runner external so `@clawboo/team-orchestration/contract` binds to
  // the CONSUMER's vitest instance at runtime (a bundled copy would register its
  // describe/it on a detached collector and the contract would silently never run).
  external: ['vitest'],
})
