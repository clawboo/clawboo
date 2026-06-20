import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries: the trait/union/registry barrel (browser-safe, no test deps)
  // and the contract test-suite (imports vitest — exposed under the `./contract`
  // subpath so app consumers of the main barrel never pull a test runner in).
  // Named entries → flat, predictable dist names (index.js / contract.js /
  // tiers.js). `tiers` is the KV-cache prompt-assembly discipline (browser-safe).
  entry: { index: 'src/index.ts', contract: 'src/contract.ts', tiers: 'src/tiers/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Keep the test runner external so `@clawboo/executor/contract` binds to the
  // CONSUMER's vitest instance at runtime (a bundled copy would register its
  // describe/it on a detached collector and the adapter's contract tests would
  // silently never run).
  external: ['vitest'],
})
