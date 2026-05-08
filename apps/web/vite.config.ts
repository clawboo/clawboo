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
  plugins: [react(), tsconfigPaths({ ignoreConfigErrors: true })],
  build: { outDir: 'dist/ui' },
  server: {
    port: 5173,
    proxy: {
      '/api/gateway/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      '/api': { target: `http://localhost:${apiPort}` },
    },
  },
})
