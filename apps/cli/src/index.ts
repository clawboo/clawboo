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

  const DASHBOARD_URL = 'http://localhost:3000'

  let dashboardRunning = await probePort('localhost', 3000, 1_500)
  if (!dashboardRunning) {
    // Strategy 1: Bundled mode — server.js sits next to this CLI entry
    const bundledServerPath = path.join(__dirname, 'server.js')

    // Strategy 2: Dev mode — find monorepo root and use tsx
    const monorepoRoot = findMonorepoRoot()
    const devServerPath = monorepoRoot ? path.join(monorepoRoot, 'apps/web/server/index.ts') : null

    if (fs.existsSync(bundledServerPath)) {
      // ── Bundled mode: fork the pre-compiled server.js ──────────────────
      const startSpinner = ora({
        text: 'Starting Clawboo...',
        color: 'cyan',
      }).start()

      const child = fork(bundledServerPath, [], {
        cwd: __dirname,
        env: { ...process.env, NODE_ENV: 'production' },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      // Poll for up to 15 seconds
      const maxAttempts = 30
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 500))
        dashboardRunning = await probePort('localhost', 3000, 1_000)
        if (dashboardRunning) break
      }

      if (dashboardRunning) {
        startSpinner.succeed(chalk.green('Dashboard started'))
      } else {
        startSpinner.fail(chalk.yellow('Dashboard is taking too long to start.'))
        process.exit(0)
      }
    } else if (devServerPath && fs.existsSync(devServerPath)) {
      // ── Dev mode: spawn tsx on the TypeScript source ────────────────────
      const startSpinner = ora({
        text: 'Starting Clawboo (dev mode)...',
        color: 'cyan',
      }).start()

      const child = spawn('npx', ['tsx', devServerPath], {
        cwd: monorepoRoot!,
        env: { ...process.env, NODE_ENV: 'production' },
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      const maxAttempts = 30
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((r) => setTimeout(r, 500))
        dashboardRunning = await probePort('localhost', 3000, 1_000)
        if (dashboardRunning) break
      }

      if (dashboardRunning) {
        startSpinner.succeed(chalk.green('Dashboard started'))
      } else {
        startSpinner.fail(
          chalk.yellow('Dashboard is taking too long to start. Try: ') +
            chalk.white(`cd ${monorepoRoot!} && pnpm dev`),
        )
        process.exit(0)
      }
    } else {
      // ── No server found ────────────────────────────────────────────────
      console.log()
      p.log.warn(
        chalk.yellow('Could not find the Clawboo server. ') +
          chalk.white('Install with: npm install -g clawboo'),
      )
      process.exit(0)
    }
  }

  // ── 4. Open browser ────────────────────────────────────────────────────────

  const browserSpinner = ora({ text: 'Opening Clawboo...', color: 'cyan' }).start()
  await openBrowser(DASHBOARD_URL)
  browserSpinner.succeed(chalk.green('Clawboo opened at ') + chalk.cyan.underline(DASHBOARD_URL))

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
      chalk.cyan.underline(DASHBOARD_URL) +
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
