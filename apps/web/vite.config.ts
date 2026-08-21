import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

// Resolve the API server's port at config-load time so the dev proxy
// targets the right backend. Three sources in priority order:
//   1. CLAWBOO_API_PORT env var — set by the dev orchestrator script so
//      both Vite and the API see the same port (no race).
//   2. The runtime file written by the API server on successful bind.
//      Read synchronously here; fine because Vite config loads once at
//      startup. If the file doesn't exist yet (Vite started before the
//      API), we fall through to the default — which is what the API will
//      also pick when 18790 is free.
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

  const stateDir = process.env['OPENCLAW_STATE_DIR']?.trim() || path.join(os.homedir(), '.openclaw')
  const portFile = path.join(stateDir, 'clawboo', 'api-port.txt')
  try {
    const raw = fs.readFileSync(portFile, 'utf8').trim()
    const port = parseInt(raw, 10)
    if (Number.isFinite(port) && port > 0) return port
  } catch {
    /* file missing — fall through to default */
  }

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

          if (!p.includes('node_modules')) {
            // The ~4.4 MB agent + team catalogs are pure static data reachable ONLY
            // from two dynamic entries — the lazy MarketplacePanel and the lazy
            // CreateTeamModal (see features/teams/CreateTeamModalLazy.tsx). Naming
            // the chunk keeps both sharing one copy and makes the split verifiable
            // by name in dist/ui/assets (scripts/check-entry-chunk.mjs asserts the
            // entry does not preload it).
            //
            // NOTE: this rule alone would NOT defer anything. A manual chunk that a
            // static import still reaches becomes a modulepreload of the entry and
            // is downloaded at boot regardless of its name — the lazy boundary is
            // the load-bearing half. Issue #83.
            //
            // The 'marketplace/' segment is required: a bare 'features/teams/' would
            // also swallow src/features/teams/* (the modal, RuntimeSelect, …) into
            // the data chunk. The trailing slashes keep marketplace/teamCatalog.ts
            // (glue, not data) with its consumers.
            if (
              p.includes('/src/features/marketplace/agents/') ||
              p.includes('/src/features/marketplace/teams/')
            )
              return 'marketplace-catalog'
            return
          }

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
