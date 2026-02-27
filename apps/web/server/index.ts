import http from 'node:http'

import next from 'next'

import { createAccessGate, createGatewayProxy } from '@clawboo/gateway-proxy'
import { loadSettings } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'

// ── Loggers ─────────────────────────────────────────────────────────────────

const log = createLogger('server')
const reqLog = createLogger('http')

// ── Helpers ──────────────────────────────────────────────────────────────────

const resolveHost = (): string => {
  const fromEnv = process.env['HOST']?.trim() || process.env['HOSTNAME']?.trim()
  return fromEnv || '0.0.0.0'
}

const resolvePort = (): number => {
  const raw = process.env['PORT']?.trim() || '3000'
  const port = Number(raw)
  return Number.isFinite(port) && port > 0 ? port : 3000
}

const resolvePathname = (url: string | undefined): string => {
  const raw = typeof url === 'string' ? url : ''
  const idx = raw.indexOf('?')
  return (idx === -1 ? raw : raw.slice(0, idx)) || '/'
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dev = process.argv.includes('--dev')
  const hostname = resolveHost()
  const port = resolvePort()

  log.info({ dev, hostname, port }, 'Starting Clawboo server')

  // ── Next.js ──────────────────────────────────────────────────────────────

  const app = next({ dev, hostname, port })
  const handle = app.getRequestHandler()

  // ── Access gate ───────────────────────────────────────────────────────────

  const accessGate = createAccessGate({
    token: process.env['STUDIO_ACCESS_TOKEN'],
  })

  // ── Gateway proxy ─────────────────────────────────────────────────────────

  const proxy = createGatewayProxy({
    loadUpstreamSettings: async () => {
      const settings = loadSettings(process.env)
      return { url: settings.gatewayUrl, token: settings.gatewayToken }
    },
    allowWs: (req) => {
      if (resolvePathname(req.url) !== '/api/gateway/ws') return false
      if (!accessGate.allowUpgrade(req)) return false
      return true
    },
    log: (msg, meta) => log.info(meta ?? {}, msg),
    logError: (msg, err) => log.error({ err }, msg),
  })

  // ── Prepare Next.js ───────────────────────────────────────────────────────

  await app.prepare()
  const handleUpgrade = app.getUpgradeHandler()

  // ── HTTP server ───────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    const start = Date.now()
    const url = req.url ?? '/'

    // Per-request structured log on response finish.
    // Skip high-frequency Next.js static asset requests to keep logs readable.
    res.on('finish', () => {
      if (url.startsWith('/_next/static/') || url.startsWith('/_next/image')) return
      const durationMs = Date.now() - start
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      reqLog[level]({ method: req.method, url, status: res.statusCode, durationMs })
    })

    if (accessGate.handleHttp(req, res)) return
    void handle(req, res)
  })

  // ── WebSocket upgrade routing ─────────────────────────────────────────────

  server.on('upgrade', (req, socket, head) => {
    if (resolvePathname(req.url) === '/api/gateway/ws') {
      proxy.handleUpgrade(req, socket, head)
      return
    }
    // Delegate all other WS upgrades (e.g. Next.js HMR in dev mode) to Next.js
    handleUpgrade(req, socket, head)
  })

  // ── Listen ────────────────────────────────────────────────────────────────

  server.listen(port, hostname, () => {
    const hostForBrowser = hostname === '0.0.0.0' ? 'localhost' : hostname
    const browserUrl = `http://${hostForBrowser}:${port}`
    log.info({ url: browserUrl }, `Clawboo ready — open in browser: ${browserUrl}`)
  })
}

main().catch((err: unknown) => {
  log.error({ err }, 'Server startup failed')
  process.exitCode = 1
})
