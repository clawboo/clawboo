/**
 * apps/cli/src/index.ts
 * Clawboo launcher — npx clawboo
 *
 * Thin launcher: start the dashboard server → open the browser.
 * The web UI handles Gateway detection, onboarding, and team deployment.
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as p from '@clack/prompts'
import ora from 'ora'
import { createConnection } from 'net'
import { exec, fork, spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

// ─── Version ──────────────────────────────────────────────────────────────────

declare const __CLI_VERSION__: string
const VERSION = typeof __CLI_VERSION__ !== 'undefined' ? __CLI_VERSION__ : '0.0.0-dev'

// ─── ASCII Logo ───────────────────────────────────────────────────────────────

const LOGO = `
 ██████╗██╗      █████╗ ██╗    ██╗██████╗  ██████╗  ██████╗
██╔════╝██║     ██╔══██╗██║    ██║██╔══██╗██╔═══██╗██╔═══██╗
██║     ██║     ███████║██║ █╗ ██║██████╔╝██║   ██║██║   ██║
██║     ██║     ██╔══██║██║███╗██║██╔══██╗██║   ██║██║   ██║
╚██████╗███████╗██║  ██║╚███╔███╔╝██████╔╝╚██████╔╝╚██████╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═════╝  ╚═════╝  ╚═════╝
`

const TAGLINE = '   Deploy, orchestrate, and observe your AI agent fleet'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === 'darwin'
        ? `open "${url}"`
        : process.platform === 'win32'
          ? `start "" "${url}"`
          : `xdg-open "${url}"`
    exec(cmd, () => resolve())
  })
}

/** Quick TCP probe to check if a port is accepting connections. */
function probePort(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port })
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(false)
    }, timeoutMs)
    sock.on('connect', () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Verify a port is hosting Clawboo's dashboard (not some other service that
 * happens to be TCP-listening on the same port). Cheap TCP-probe first to
 * skip closed ports, then an HTTP GET /api/settings that validates a
 * Clawboo-shaped JSON response. Critical because Clawboo's auto-fallback
 * range (18790-18809) overlaps with the OpenClaw Gateway's auxiliary ports
 * (18791-18792) AND with things like Chrome's --remote-debugging-port
 * (commonly 18800). A naive TCP probe accepts any of those as "Clawboo",
 * routes the browser there, and the user sees an unrelated 401 / empty
 * page / DevTools UI.
 */
async function probeClawbooDashboard(
  host: string,
  port: number,
  timeoutMs = 1_500,
): Promise<boolean> {
  // Cheap TCP probe first — skip the HTTP cost on closed ports.
  if (!(await probePort(host, port, Math.min(timeoutMs, 1_000)))) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`http://${host}:${port}/api/settings`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return false
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('application/json')) return false
    const body = (await res.json()) as Record<string, unknown>
    // Clawboo's /api/settings ALWAYS includes these two fields. Gateway's
    // auxiliary ports return plain "Unauthorized"; Chrome's debug returns
    // an array of debugger targets — neither matches this shape.
    return typeof body['gatewayUrl'] === 'string' && typeof body['hasToken'] === 'boolean'
  } catch {
    return false
  }
}

// ─── Dashboard port discovery ─────────────────────────────────────────────────
//
// Mirrors `apps/web/server/lib/portUtils.ts` — kept in lockstep:
// - DEFAULT_API_PORT 18790 (one above OpenClaw Gateway 18789)
// - 20-port fallback window (18790-18809)
// - Runtime port file at <state-dir>/clawboo/api-port.txt
//
// On every `npx clawboo` launch we figure out where the dashboard is or
// will be, in this priority order:
//   1. CLAWBOO_API_PORT / CLAWBOO_API_URL env var (explicit user override)
//   2. Runtime port file (server already running, wrote its port there)
//   3. Probe DEFAULT_API_PORT, then scan upward 19 more ports
//   4. Fall back to DEFAULT_API_PORT (we'll start a server there)

const DEFAULT_API_PORT = 18790
const MAX_PORT_ATTEMPTS = 20

function readPortEnv(name: string): number | null {
  const raw = (process.env[name] ?? '').trim()
  if (!raw) return null
  const port = Number(raw)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return port
}

function getRuntimePortFilePath(): string {
  const stateDir =
    (process.env.OPENCLAW_STATE_DIR ?? '').trim() ||
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.openclaw')
  return path.join(stateDir, 'clawboo', 'api-port.txt')
}

function readRuntimePort(): number | null {
  try {
    const raw = fs.readFileSync(getRuntimePortFilePath(), 'utf8').trim()
    const port = Number(raw)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
    return port
  } catch {
    return null
  }
}

/**
 * Find an already-running Clawboo dashboard. Returns the port if a port in
 * the search space hosts Clawboo (validated via HTTP signature), null
 * otherwise. Tries: env var → runtime file → port-range scan from 18790.
 *
 * Uses `probeClawbooDashboard` (TCP probe + Clawboo-shaped JSON check) so
 * unrelated services that happen to listen in 18790-18809 — Gateway aux
 * ports, Chrome --remote-debugging-port, etc. — are correctly skipped
 * instead of mistaken for Clawboo.
 */
async function findRunningDashboard(): Promise<number | null> {
  const explicit = readPortEnv('CLAWBOO_API_PORT')
  if (explicit !== null) {
    if (await probeClawbooDashboard('localhost', explicit, 1_500)) return explicit
    return null
  }
  const fromFile = readRuntimePort()
  if (fromFile !== null && (await probeClawbooDashboard('localhost', fromFile, 1_500))) {
    return fromFile
  }
  // Scan the standard window — covers the case where the server was started
  // by `pnpm dev` or another launcher and never wrote the runtime file.
  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port = DEFAULT_API_PORT + i
    if (await probeClawbooDashboard('localhost', port, 800)) return port
  }
  return null
}

// ─── Monorepo discovery ────────────────────────────────────────────────────────

/**
 * Walk up from __dirname and cwd looking for the Clawboo monorepo root
 * (a package.json with "name": "clawboo").
 */
function findMonorepoRoot(): string | null {
  // Env override
  if (process.env.CLAWBOO_SERVER_PATH) return process.env.CLAWBOO_SERVER_PATH

  const candidates: string[] = []

  // Walk up from this file's directory
  {
    let dir = __dirname
    for (let i = 0; i < 10; i++) {
      candidates.push(dir)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  // Walk up from cwd
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (!candidates.includes(dir)) candidates.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, 'package.json')
      const raw = fs.readFileSync(pkgPath, 'utf-8')
      const pkg = JSON.parse(raw) as { name?: string }
      if (pkg.name === 'clawboo') return candidate
    } catch {
      // not found or not parsable — continue
    }
  }

  return null
}

// ─── Main run ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // 1. Print logo
  console.log(chalk.hex('#E94560').bold(LOGO))
  console.log(chalk.hex('#E94560')(TAGLINE))
  console.log()

  p.intro(chalk.bold.white('Clawboo') + chalk.gray(' v' + VERSION))

  // ── 2. Informational gateway probe ─────────────────────────────────────────

  const gatewayUp = await probePort('localhost', 18789)
  if (gatewayUp) {
    p.log.success(chalk.green('OpenClaw Gateway detected') + chalk.gray(' at localhost:18789'))
  } else {
    p.log.info(chalk.gray('No Gateway detected — the dashboard will guide you through setup.'))
  }

  // ── 3. Start dashboard server ──────────────────────────────────────────────

  // Discover or start the dashboard. The server picks its own port via the
  // shared port resolver (default 18790 with auto-fallback up to 18809), so
  // the CLI doesn't hardcode anything — it queries `findRunningDashboard()`
  // before AND after spawning to learn the actual port.
  let dashboardPort = await findRunningDashboard()
  if (dashboardPort === null) {
    // Strategy 1: Bundled mode — server.js sits next to this CLI entry
    const bundledServerPath = path.join(__dirname, 'server.js')

    // Strategy 2: Dev mode — find monorepo root and use tsx
    const monorepoRoot = findMonorepoRoot()
    const devServerPath = monorepoRoot ? path.join(monorepoRoot, 'apps/web/server/index.ts') : null

    const launchedFrom: 'bundled' | 'dev' | null = fs.existsSync(bundledServerPath)
      ? 'bundled'
      : devServerPath && fs.existsSync(devServerPath)
        ? 'dev'
        : null

    if (launchedFrom === null) {
      // ── No server found ────────────────────────────────────────────────
      console.log()
      p.log.warn(
        chalk.yellow('Could not find the Clawboo server. ') +
          chalk.white('Install with: npm install -g clawboo'),
      )
      process.exit(0)
    }

    const startSpinner = ora({
      text: launchedFrom === 'bundled' ? 'Starting Clawboo...' : 'Starting Clawboo (dev mode)...',
      color: 'cyan',
    }).start()

    if (launchedFrom === 'bundled') {
      const child = fork(bundledServerPath, [], {
        cwd: __dirname,
        env: { ...process.env, NODE_ENV: 'production' },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    } else {
      const child = spawn('npx', ['tsx', devServerPath!], {
        cwd: monorepoRoot!,
        env: { ...process.env, NODE_ENV: 'production' },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()
    }

    // Poll for the dashboard via port discovery (env / runtime file / scan).
    // Up to 45 seconds. The server typically binds in ~500ms on a warm
    // install, but on Windows the FIRST cold boot of the bundled CJS (1.4 MB
    // + better-sqlite3 native bindings + Express + WS proxy) can take 20-30s
    // due to Windows Defender real-time scanning of the freshly-extracted
    // npm package + Node's first-load module compile. 15s timed out on
    // fresh Windows installs — see v0.1.7 round-2 Windows compat fix.
    const maxAttempts = 90
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 500))
      const found = await findRunningDashboard()
      if (found !== null) {
        dashboardPort = found
        break
      }
    }

    if (dashboardPort !== null) {
      startSpinner.succeed(chalk.green('Dashboard started'))
    } else {
      const hint =
        launchedFrom === 'dev'
          ? chalk.yellow('Dashboard is taking too long to start. Try: ') +
            chalk.white(`cd ${monorepoRoot!} && pnpm dev`)
          : chalk.yellow('Dashboard is taking too long to start.')
      startSpinner.fail(hint)
      process.exit(0)
    }
  }

  const dashboardUrl = `http://localhost:${dashboardPort}`

  // ── 4. Open browser ────────────────────────────────────────────────────────

  const browserSpinner = ora({ text: 'Opening Clawboo...', color: 'cyan' }).start()
  await openBrowser(dashboardUrl)
  browserSpinner.succeed(chalk.green('Clawboo opened at ') + chalk.cyan.underline(dashboardUrl))

  // ── 5. Success ─────────────────────────────────────────────────────────────

  console.log()
  p.outro(
    chalk.bold.hex('#E94560')('Clawboo is ready!') +
      '\n\n' +
      chalk.white('  What to do next:') +
      '\n' +
      chalk.gray('  •  Deploy a pre-built team or create your own') +
      '\n' +
      chalk.gray('  •  Open Ghost Graph to see your agent topology') +
      '\n' +
      chalk.gray('  •  Browse the Marketplace for skills and team templates') +
      '\n' +
      chalk.gray('  •  Track costs and optimize with Frugal Toggle') +
      '\n\n' +
      chalk.gray('  Clawboo:   ') +
      chalk.cyan.underline(dashboardUrl) +
      '\n' +
      chalk.gray('  Docs:      ') +
      chalk.cyan.underline('https://clawboo.dev/docs'),
  )
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name('clawboo')
  .description('The open-source platform for OpenClaw agent teams')
  .version(VERSION)

program.action(() => {
  run().catch((err: unknown) => {
    console.error(chalk.red('\nError:'), err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
})

program.parse()
