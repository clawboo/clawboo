import { resolveClawbooDir } from '@clawboo/config'
import { checkStartMarker, readPortRecord, startTimesReader } from '@clawboo/process-lookup'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Resolve the API server's port at config-load time so the dev proxy
// targets the right backend. Three sources in priority order:
//   1. CLAWBOO_API_PORT env var — set by the dev orchestrator script so
//      both Vite and the API see the same port (no race).
//   2. The runtime file written by the API server on successful bind
//      (`<clawboo dir>/api-port.txt`), unless the start marker beside it
//      shows the server that wrote it is gone. Read synchronously here; fine
//      because Vite config loads once at startup. If the file doesn't exist
//      yet (Vite started before the API), we fall through to the default,
//      which is what the API will also pick when 18790 is free.
//   3. Default port (18790). Mirrors DEFAULT_API_PORT in
//      `server/lib/portUtils.ts`.
//
// The two-process race (Vite reads default → API picks default) usually
// agrees; the dev orchestrator eliminates it entirely by setting the env
// var first.
const DEFAULT_API_PORT = 18790

function resolveApiPort(): number {
  const envPort = parseInt(process.env['CLAWBOO_API_PORT'] ?? '', 10)
  if (Number.isFinite(envPort) && envPort > 0) return envPort

  // The server's own folder (CLAWBOO_HOME, else ~/.clawboo), read the way the
  // `clawboo` command reads it: one start-time probe, given up after 8 s on
  // Windows. Never throws; a missing file is a null port.
  const record = readPortRecord(resolveClawbooDir(process.env), (marker) =>
    checkStartMarker(marker, { startTimes: startTimesReader(8_000) }),
  )
  if (record.port !== null && record.trust !== 'stale') return record.port

  return DEFAULT_API_PORT
}

const apiPort = resolveApiPort()

export default defineConfig({
  // RELATIVE, so one prebuilt bundle serves from any mount point. clawboo ships
  // `dist/ui` through npm, so a build-time absolute base would force users to
  // rebuild just to serve under a path prefix. With './' every asset URL the
  // bundle emits resolves at RUNTIME: JS-hosted ones against the importing
  // chunk's own URL, CSS ones against the stylesheet, and index.html's own refs
  // against the `<base href>` the server injects (see `server/lib/serveSpa.ts`).
  base: './',
  plugins: [react(), tsconfigPaths({ ignoreConfigErrors: true })],
  build: {
    outDir: 'dist/ui',
    rollupOptions: {
      output: {
        // Split the heaviest vendor libraries into their own chunks so they're
        // not part of the entry chunk. Combined with the lazy panels/graph, a
        // first-run user only downloads/parses these when they open the feature
        // that needs them (editor, charts, or the graph).
        // d3-* gets its own chunk rather than being folded into `charts`.
        // React Flow and recharts both depend on parts of d3, so letting it
        // land in `charts` couples the two — anything that pulls the graph then
        // drags recharts (~383 KB) onto the same load path. An explicit `d3`
        // chunk lets each side depend on the shared code independently.
        manualChunks(id) {
          // Rollup ids are '/'-separated, but normalize anyway — CI also builds on
          // windows-latest (the smoke-test-bundle matrix).
          const p = id.replace(/\\/g, '/')

          // App code takes the default chunking. The marketplace catalog used to be
          // pulled out here as a named `marketplace-catalog` chunk (~4.4 MB); it is
          // JSON packs under `catalog/` now, excluded from the tarball and fetched
          // from `/api/catalog/*`, so there is no data module left to name. Only
          // the small generated seed is compiled in, and it rides the lazy
          // marketplace chunk. The early return is kept so an app path can never
          // fall through into the vendor rules below.
          if (!p.includes('node_modules')) return

          if (p.includes('@codemirror') || p.includes('/codemirror/') || p.includes('@lezer'))
            return 'codemirror'
          if (p.includes('@xyflow') || p.includes('elkjs')) return 'graph'
          if (p.includes('recharts')) return 'charts'
          if (p.includes('/d3-') || p.includes('/internmap/') || p.includes('/victory-vendor/'))
            return 'd3'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api/gateway/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      '/api': { target: `http://localhost:${apiPort}` },
    },
  },
})
