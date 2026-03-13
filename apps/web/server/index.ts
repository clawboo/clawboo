import http from 'node:http'
import path from 'node:path'

import express from 'express'
import cors from 'cors'

import { createAccessGate, createGatewayProxy } from '@clawboo/gateway-proxy'
import { loadSettings } from '@clawboo/config'
import { createLogger } from '@clawboo/logger'

import { apiRouter } from './api/index'

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

  // ── Express app ───────────────────────────────────────────────────────────

  const app = express()

  // CORS: only needed in dev (Vite on :5173 → Express on :3000)
  if (dev) {
    app.use(cors({ origin: true, credentials: true }))
  }

  // JSON body parser — must be before API routes
  app.use(express.json({ limit: '2mb' }))

  // Access gate middleware
  app.use((req, res, next) => {
    if (accessGate.handleHttp(req, res)) return
    next()
  })

  // Per-request logging
  app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
      const url = req.originalUrl ?? req.url
      // Skip high-frequency static asset requests
      if (url.startsWith('/assets/') || url.startsWith('/fonts/')) return
      const durationMs = Date.now() - start
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      reqLog[level]({ method: req.method, url, status: res.statusCode, durationMs })
    })
    next()
  })

  // API routes
  app.use(apiRouter)

  // Production: serve Vite build output as static SPA
  if (!dev) {
    const uiDir = path.join(__dirname, '..', 'dist', 'ui')
    app.use(express.static(uiDir))
    // SPA catch-all: non-API requests get index.html
    app.get('*', (_req, res) => {
      res.sendFile(path.join(uiDir, 'index.html'))
    })
  }

  // ── HTTP server (raw, for WS upgrade handling) ────────────────────────────

  const server = http.createServer(app)

  // ── WebSocket upgrade routing ─────────────────────────────────────────────

  server.on('upgrade', (req, socket, head) => {
    if (resolvePathname(req.url) === '/api/gateway/ws') {
      proxy.handleUpgrade(req, socket, head)
      return
    }
    // No other WS upgrades needed (Vite HMR runs on its own port)
    socket.destroy()
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
