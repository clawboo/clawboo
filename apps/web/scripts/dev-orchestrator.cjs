#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// Dev orchestrator — picks a free API port BEFORE starting the API and
// Vite together, so both processes agree on the port without a race.
//
// Default port: 18790 (one above the OpenClaw Gateway's 18789, in the
// uncommonly-used 18000-18999 range). If 18790 is taken, scans up to 20
// consecutive ports. If `CLAWBOO_API_PORT` is already set in the env, we
// trust the caller and skip the scan.
//
// Mirrors the logic in `server/lib/portUtils.ts` — kept in sync because
// this script runs in plain CommonJS Node BEFORE TypeScript compilation,
// so it can't `require` the typed helper directly.

const net = require('node:net')
const { spawn } = require('node:child_process')

const DEFAULT_API_PORT = 18790
const MAX_PORT_ATTEMPTS = 20

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    let settled = false
    const settle = (free) => {
      if (settled) return
      settled = true
      try {
        probe.close()
      } catch {
        /* ignore */
      }
      resolve(free)
    }
    probe.once('error', () => settle(false))
    probe.once('listening', () => settle(true))
    try {
      probe.listen(port, '0.0.0.0')
    } catch {
      settle(false)
    }
  })
}

async function findFreePort(start, attempts) {
  for (let i = 0; i < attempts; i++) {
    const port = start + i
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port available in range ${start}-${start + attempts - 1}. ` +
      `Free a port in this range or set CLAWBOO_API_PORT=<port>.`,
  )
}

function readPortEnv(name) {
  const raw = (process.env[name] || '').trim()
  if (!raw) return null
  const port = Number(raw)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return port
}

async function main() {
  // 1. Decide the port up-front so both children inherit the same value.
  let port = readPortEnv('CLAWBOO_API_PORT')
  if (port !== null) {
    if (!(await isPortFree(port))) {
      console.error(`[dev-orchestrator] CLAWBOO_API_PORT=${port} is already in use.`)
      process.exit(1)
    }
  } else {
    const start = readPortEnv('CLAWBOO_API_PORT_START') ?? DEFAULT_API_PORT
    port = await findFreePort(start, MAX_PORT_ATTEMPTS)
  }

  console.log(`\n[clawboo-dev] API port: ${port}  ·  UI port: 5173`)
  if (port !== DEFAULT_API_PORT) {
    console.log(`[clawboo-dev] (${DEFAULT_API_PORT} was busy — picked next free port)`)
  }
  console.log()

  // 2. Spawn `concurrently` with both processes inheriting the chosen port.
  // We use `concurrently` (already a dev dep) so behavior matches the old
  // script — colored prefixes, single Ctrl-C kills both, etc.
  const env = { ...process.env, CLAWBOO_API_PORT: String(port) }
  const child = spawn(
    'pnpm',
    [
      'exec',
      'concurrently',
      '-n',
      'api,ui',
      '-c',
      'blue,green',
      '--kill-others-on-fail',
      'pnpm dev:api',
      'pnpm dev:ui',
    ],
    { stdio: 'inherit', env, shell: false },
  )
  child.on('exit', (code) => process.exit(code ?? 0))
  // Forward signals so Ctrl-C propagates cleanly.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      try {
        child.kill(sig)
      } catch {
        /* ignore */
      }
    })
  }
}

main().catch((err) => {
  console.error('[dev-orchestrator]', err.message ?? err)
  process.exit(1)
})
