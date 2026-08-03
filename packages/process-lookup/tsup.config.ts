import { defineConfig } from 'tsup'

export default defineConfig({
  // Server-only: shells out to lsof / netstat via node:child_process. Inlined
  // into the tsup server bundle and into the standalone `clawboo` CLI alike.
  entry: { index: 'src/index.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
})
