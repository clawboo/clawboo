/**
 * apps/cli/src/index.ts
 * Clawboo launcher — npx clawboo
 *
 * Thin launcher: start the dashboard server → open the browser.
 * The web UI handles Gateway detection, onboarding, and team deployment.
 *
 * Alongside the default action it carries three subcommands — `backup`, `stop`,
 * and `restart` — which exist because the server runs DETACHED: copying a live
 * database, clearing an instance you can no longer Ctrl-C, and rolling a running
 * instance onto a newer build are all awkward without them.
 *
 * This file is presentation + Commander wiring only. The find/start/stop
 * primitives live in `lifecycle.ts` so they can be unit-tested (importing this
 * module would run `program.parse()`).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import * as p from '@clack/prompts'
import ora, { type Ora } from 'ora'
import { exec } from 'child_process'
import path from 'path'
import fs from 'fs'

import { resolveClawbooDir } from '@clawboo/config'

import { VERSION } from './version'
import { shouldOfferRestart } from './versionCheck'
import {
  discoverDashboard,
  fetchServerVersion,
  probeClawbooDashboard,
  probePort,
  readRuntimePort,
  removeRuntimePortFile,
  startDashboard,
  stopDashboard,
  type StopOutcome,
} from './lifecycle'

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

/** Shared terminal error path for every command's action handler. */
function fail(err: unknown): never {
  console.error(chalk.red('\nError:'), err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// ─── Server start / stop reporting ────────────────────────────────────────────

/**
 * Start a dashboard and narrate it. Returns the port, or null when the user is
 * left without one — the caller picks the exit code, because the default
 * launcher and `restart` want different ones.
 */
async function startAndReport(opts: {
  port?: number
  verb: 'Starting' | 'Restarting'
}): Promise<number | null> {
  // Held in an object so the spinner is only created once `startDashboard` has
  // actually found a server to launch — the "no server anywhere" path must not
  // print a "Starting Clawboo..." line for something it never started.
  const ui: { spinner: Ora | undefined } = { spinner: undefined }

  const outcome = await startDashboard({
    port: opts.port,
    onLaunch: (mode) => {
      const suffix = mode === 'dev' ? ' (dev mode)' : ''
      ui.spinner = ora({ text: `${opts.verb} Clawboo${suffix}...`, color: 'cyan' }).start()
    },
  })

  if (outcome.status === 'no-server') {
    // ── No server found ──────────────────────────────────────────────────────
    console.log()
    p.log.warn(
      chalk.yellow('Could not find the Clawboo server. ') +
        chalk.white('Install with: npm install -g clawboo'),
    )
    return null
  }

  if (outcome.status === 'timeout') {
    const hint =
      outcome.mode === 'dev' && outcome.monorepoRoot
        ? chalk.yellow('Dashboard is taking too long to start. Try: ') +
          chalk.white(`cd ${outcome.monorepoRoot} && pnpm dev`)
        : chalk.yellow('Dashboard is taking too long to start.')
    ui.spinner?.fail(hint)
    return null
  }

  ui.spinner?.succeed(
    chalk.green(opts.verb === 'Restarting' ? 'Dashboard restarted' : 'Dashboard started'),
  )
  return outcome.port
}

function describeStopFailure(outcome: StopOutcome): string {
  if (outcome.status === 'still-alive') {
    return `The server on port ${outcome.port} did not exit.`
  }
  if (outcome.status === 'could-not-identify' && outcome.reason === 'permission-denied') {
    return `The process on port ${outcome.port} belongs to another user.`
  }
  if (outcome.status === 'could-not-identify' && outcome.reason === 'unsafe-pid') {
    return `Port ${outcome.port} is held by a process this launcher refuses to signal.`
  }
  return `Could not identify the process listening on port ${outcome.port}.`
}

/**
 * A Clawboo dashboard is running but its access gate is turned on, so every
 * `/api/*` call from here 401s. Say so instead of behaving as if nothing were
 * running — which would fork a second server onto the same database, fail its
 * readiness poll, and leave the first one orphaned.
 */
function printGatedNotice(port: number): void {
  p.log.warn(
    chalk.yellow(`A Clawboo server is running on port ${port}, but it requires an access token.`),
  )
  p.log.info(
    chalk.gray('This install sets ') +
      chalk.white('STUDIO_ACCESS_TOKEN') +
      chalk.gray(', so every /api/* route needs a cookie the launcher does not have.'),
  )
  p.log.info(
    chalk.gray('Open ') +
      chalk.cyan.underline(`http://localhost:${port}/?access_token=<token>`) +
      chalk.gray(' once to set it in your browser, or unset the variable and restart the server.'),
  )
}

/**
 * We stopped a server that was working and could not put one back. Say so
 * explicitly: `startAndReport`'s own messages ("Could not find the Clawboo
 * server", "taking too long to start") read as if nothing had been running.
 */
function printStoppedNotReplaced(port: number): void {
  p.log.warn(
    chalk.yellow('The previous server was stopped and could not be replaced. ') +
      chalk.white('Nothing is running now.'),
  )
  p.log.info(
    chalk.gray('Start one with ') +
      chalk.white('clawboo') +
      chalk.gray(`, on port ${port} if it is still free.`),
  )
}

/** Deliberately not "run `clawboo stop`" — that is what just failed. */
function printManualStopHint(port: number): void {
  const cmd =
    process.platform === 'win32'
      ? `netstat -ano | findstr :${port}   →   taskkill /PID <pid> /F`
      : `lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill`
  p.log.info(chalk.gray('Stop it manually: ') + chalk.white(cmd))
}

// ─── Main run ─────────────────────────────────────────────────────────────────

export interface LaunchOptions {
  /** False when `--no-version-check` is passed. */
  versionCheck: boolean
  /** True when `-y` / `--yes` is passed. */
  yes: boolean
}

/**
 * The running server is older than this launcher, so offer to restart it rather
 * than silently attaching to stale code.
 *
 * Returns the port to attach to, or null when it stopped the old server and the
 * replacement never came up. Null is NOT "nothing is running yet": a child has
 * already been forked and may still be binding, so the caller must bail rather
 * than fork a second one.
 *
 * Every other branch ends with the user at a working dashboard: a declined offer
 * or a failed stop attaches to the old server rather than leaving them with
 * nothing.
 */
async function reconcileServerVersion(port: number, opts: LaunchOptions): Promise<number | null> {
  const serverVersion = await fetchServerVersion(port)
  if (!shouldOfferRestart(VERSION, serverVersion)) return port

  p.log.warn(
    chalk.yellow(`The Clawboo server on port ${port} is running v${serverVersion}`) +
      chalk.gray(` — this launcher is v${VERSION}.`),
  )

  // A prompt needs a real terminal on both ends. @clack/prompts drives stdin
  // directly: pointed at /dev/null it throws (`uv_tty_init EINVAL`), and pointed
  // at a pipe it blocks forever. Neither is acceptable on the path whose whole
  // job is to open a browser, so a non-TTY is never asked.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  let restart = opts.yes

  if (!restart && interactive) {
    let answer: boolean | symbol
    try {
      answer = await p.confirm({
        message: `Restart it on port ${port} to run v${VERSION}?`,
        initialValue: true,
      })
    } catch {
      // A terminal we couldn't drive. Attaching is always the safe answer.
      answer = false
    }
    // Ctrl-C here means "just take me to the dashboard", not "abort the CLI".
    if (p.isCancel(answer)) {
      p.log.info(chalk.gray('Keeping the running server.'))
      return port
    }
    restart = answer
  }

  if (!restart) {
    if (!interactive) {
      p.log.info(
        chalk.gray('Attaching to it. Run ') +
          chalk.white('clawboo restart') +
          chalk.gray(' (or pass ') +
          chalk.white('-y') +
          chalk.gray(`) to pick up v${VERSION}.`),
      )
    }
    return port
  }

  const stopSpinner = ora({ text: `Stopping Clawboo v${serverVersion}...`, color: 'cyan' }).start()
  const stopped = await stopDashboard(port)
  if (stopped.status !== 'stopped') {
    stopSpinner.fail(chalk.yellow(describeStopFailure(stopped)))
    printManualStopHint(port)
    p.log.info(chalk.gray(`Continuing with the running v${serverVersion} server.`))
    return port
  }
  stopSpinner.succeed(chalk.green(`Stopped Clawboo v${serverVersion}`))

  // Pin the port only once it is genuinely free: CLAWBOO_API_PORT is an exact
  // bind and the server THROWS when it is taken, which under `stdio: 'ignore'`
  // would be a silent death. If something else grabbed it, start without a pin
  // from us and let the server resolve its own port (an auto-scan — or the
  // user's own CLAWBOO_API_PORT, if they have one exported).
  const free = !(await probePort('localhost', port, 500))
  const restarted = await startAndReport({ port: free ? port : undefined, verb: 'Restarting' })
  if (restarted === null) printStoppedNotReplaced(port)
  return restarted
}

async function run(opts: LaunchOptions): Promise<void> {
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

  // ── 3. Find or start the dashboard server ──────────────────────────────────

  // The server picks its own port via the shared port resolver (default 18790
  // with auto-fallback up to 18809), so the CLI doesn't hardcode anything — it
  // queries discovery before AND after spawning.
  const found = await discoverDashboard()
  if (found.port === null && found.gatedPort !== null) {
    // Starting another server would put a second one on the same database and
    // still leave the browser unable to reach either without the cookie.
    printGatedNotice(found.gatedPort)
    process.exit(1)
  }
  let dashboardPort = found.port

  // A server started by an earlier install stays bound to its port (it is
  // spawned detached and unref'd), so attaching blindly can land on a build
  // older than the package that was just invoked. Ask it what it is first.
  //
  // The branches are exclusive on purpose. `reconcileServerVersion` may itself
  // have stopped a server and forked a replacement; if that replacement is just
  // slow, falling through to the spawn below would fork a SECOND dashboard onto
  // the same database. Exit non-zero instead — the user asked for a dashboard
  // and does not have one either way.
  if (dashboardPort !== null && opts.versionCheck) {
    dashboardPort = await reconcileServerVersion(dashboardPort, opts)
    if (dashboardPort === null) process.exit(1)
  } else if (dashboardPort === null) {
    dashboardPort = await startAndReport({ verb: 'Starting' })
    if (dashboardPort === null) process.exit(1)
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
      chalk.gray('  •  Track token usage by team and agent') +
      '\n\n' +
      chalk.gray('  Clawboo:   ') +
      chalk.cyan.underline(dashboardUrl) +
      '\n' +
      chalk.gray('  Docs:      ') +
      chalk.cyan.underline('https://docs.claw.boo') +
      '\n\n' +
      chalk.gray('  ') +
      chalk.yellow('★') +
      chalk.gray(' If Clawboo is useful, please star it: ') +
      chalk.cyan.underline('https://github.com/clawboo/clawboo'),
  )
}

// ─── `clawboo stop` ───────────────────────────────────────────────────────────

/**
 * Stop the instance the launcher would have attached to. Discovery is shared
 * with `clawboo`, so `CLAWBOO_API_PORT=<n> clawboo stop` targets one explicitly.
 *
 * Stopping something already stopped is not an error — this has to be safe to
 * run twice from a teardown script.
 */
async function runStop(): Promise<void> {
  const { port, gatedPort } = await discoverDashboard()
  if (port === null && gatedPort !== null) {
    // It IS running — we just can't confirm it through the gate, and the safety
    // rule is to never signal a process on a port we haven't positively
    // identified as Clawboo's. Say that rather than "nothing is running".
    printGatedNotice(gatedPort)
    printManualStopHint(gatedPort)
    process.exit(1)
  }
  if (port === null) {
    // A port file naming a dead server is exactly the stale state this command
    // exists to clear — but "discovery found nothing" is not the same as "the
    // recorded port is dead". `CLAWBOO_API_PORT` short-circuits discovery to a
    // single port, so a live instance on a different one would still be named
    // by the file. Probe the recorded port before deleting the only record of it.
    const recorded = readRuntimePort()
    if (recorded !== null && !(await probeClawbooDashboard('localhost', recorded, 1_500))) {
      removeRuntimePortFile()
    }
    p.log.info(chalk.gray('No Clawboo server is running.'))
    return
  }

  const spinner = ora({ text: `Stopping Clawboo on port ${port}...`, color: 'cyan' }).start()
  const outcome = await stopDashboard(port)

  switch (outcome.status) {
    case 'stopped':
      spinner.succeed(
        chalk.green('Clawboo stopped') +
          chalk.gray(` (pid ${outcome.pid}${outcome.forced ? ', forced' : ''})`),
      )
      return
    case 'not-running':
      spinner.info(chalk.gray('No Clawboo server is running.'))
      return
    default:
      spinner.fail(chalk.yellow(describeStopFailure(outcome)))
      printManualStopHint(port)
      process.exit(1)
  }
}

// ─── `clawboo restart` ────────────────────────────────────────────────────────

/**
 * Stop the running server and start a fresh one on the same port, so a browser
 * tab already open on that URL reconnects on its own. With nothing running it
 * just starts one (the systemd convention).
 */
async function runRestart(opts: { open: boolean }): Promise<void> {
  const { port, gatedPort } = await discoverDashboard()
  if (port === null && gatedPort !== null) {
    printGatedNotice(gatedPort)
    printManualStopHint(gatedPort)
    process.exit(1)
  }

  let pinned: number | undefined
  if (port === null) {
    p.log.info(chalk.gray('No Clawboo server is running — starting one.'))
  } else {
    const spinner = ora({ text: `Stopping Clawboo on port ${port}...`, color: 'cyan' }).start()
    const outcome = await stopDashboard(port)
    if (outcome.status === 'could-not-identify' || outcome.status === 'still-alive') {
      spinner.fail(chalk.yellow(describeStopFailure(outcome)))
      printManualStopHint(port)
      // Deliberately do NOT start a replacement: a pinned start would throw on
      // the taken port, and an unpinned one would leave TWO dashboards running.
      process.exit(1)
    }
    spinner.succeed(chalk.green('Clawboo stopped'))
    // Pin only if the port really freed — a `pnpm dev` supervisor can respawn
    // the server on the same port between our stop and our start. Unpinned, the
    // successor resolves its own port the way any boot does.
    if (!(await probePort('localhost', port, 500))) pinned = port
  }

  const started = await startAndReport({ port: pinned, verb: 'Restarting' })
  if (started === null) {
    // Only when a stop actually ran — with nothing running beforehand this is a
    // plain start failure and the existing message is already accurate.
    if (port !== null) printStoppedNotReplaced(port)
    process.exit(1)
  }

  const url = `http://localhost:${started}`
  if (opts.open) {
    const browserSpinner = ora({ text: 'Opening Clawboo...', color: 'cyan' }).start()
    await openBrowser(url)
    browserSpinner.succeed(chalk.green('Clawboo opened at ') + chalk.cyan.underline(url))
  }

  console.log()
  p.outro(
    chalk.bold.hex('#E94560')('Clawboo restarted') +
      chalk.gray(' v' + VERSION) +
      '\n\n' +
      chalk.gray('  Clawboo:   ') +
      chalk.cyan.underline(url),
  )
}

// ─── `clawboo backup` ─────────────────────────────────────────────────────────

/**
 * Resolve the Clawboo SQLite database path the server actually uses — mirrors
 * `apps/web/server/lib/db.ts`'s `getDbPath()` (`resolveClawbooDir()/clawboo.db`).
 * Kept local so the launcher stays thin and doesn't pull in `@clawboo/db`.
 */
function clawbooDbPath(): string {
  return path.join(resolveClawbooDir(), 'clawboo.db')
}

function timestampedBackupName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `clawboo-backup-${stamp}.db`
}

async function runBackup(destArg: string | undefined, opts: { force: boolean }): Promise<void> {
  const source = clawbooDbPath()
  if (!fs.existsSync(source)) {
    throw new Error(
      `No Clawboo database found at ${source}. Start the server once to create it, or set CLAWBOO_HOME.`,
    )
  }

  // Resolve destination: default to ./<timestamped>.db in the cwd; if the arg
  // is an existing directory, write inside it; otherwise treat it as the file.
  let dest: string
  if (destArg) {
    dest = path.resolve(destArg)
    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
      dest = path.join(dest, timestampedBackupName())
    }
  } else {
    dest = path.resolve(timestampedBackupName())
  }

  if (fs.existsSync(dest)) {
    if (!opts.force) {
      throw new Error(`${dest} already exists. Refusing to overwrite (pass --force to clobber).`)
    }
    // better-sqlite3's `.backup()` opens the destination as a SQLite file and
    // copies pages in; it cannot overwrite a non-SQLite file (SQLITE_NOTADB) and
    // a stale smaller SQLite target would keep trailing junk pages. Unlink first
    // so the backup always writes a clean single-file image.
    fs.unlinkSync(dest)
  }

  // Open the source read-only so a backup can run while the server is live
  // without taking a write lock. better-sqlite3's online `.backup()` reads
  // pages via the shared WAL and produces a single checkpoint-consistent file
  // with no `-wal`/`-shm` sidecars — the documented "one-file" backup recipe.
  const Database = (await import('better-sqlite3')).default as typeof import('better-sqlite3')
  const src = new Database(source, { readonly: true, fileMustExist: true })
  try {
    const spinner = ora({ text: `Backing up ${source} → ${dest}`, color: 'cyan' }).start()
    await src.backup(dest)
    spinner.succeed(chalk.green('Backup complete'))
  } finally {
    src.close()
  }

  const bytes = fs.statSync(dest).size
  const kb = (bytes / 1024).toFixed(1)
  p.outro(
    chalk.bold.hex('#E94560')('Backup ready!') +
      '\n' +
      chalk.gray('  File:  ') +
      chalk.white(dest) +
      '\n' +
      chalk.gray('  Size:  ') +
      chalk.white(`${kb} KB`) +
      '\n\n' +
      chalk.gray('  This is a single checkpoint-consistent file — no ') +
      chalk.gray('`-wal`/`-shm`') +
      chalk.gray(' sidecars needed.') +
      '\n' +
      chalk.gray('  Restore by copying it back over ') +
      chalk.white('clawboo.db') +
      chalk.gray(' with the server stopped.'),
  )
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name('clawboo')
  .description('The open-source platform for OpenClaw agent teams')
  .version(VERSION)
  .option('--no-version-check', 'Skip comparing a running server against this launcher.')
  .option('-y, --yes', 'Restart an older running server without prompting.')
  .showHelpAfterError()

program.action((opts: LaunchOptions, command: Command) => {
  // Commander dispatches registered subcommands before reaching here and does
  // not reject excess operands, so a leftover operand is a subcommand name we
  // don't have. Without this `clawboo stopp` would quietly launch the dashboard
  // and open a browser — which is the opposite of what was asked for.
  const unknown = command.args[0]
  if (unknown !== undefined) program.error(`error: unknown command '${unknown}'`)
  run(opts).catch(fail)
})

program
  .command('stop')
  .description('Stop the running Clawboo dashboard server.')
  .action(() => {
    runStop().catch(fail)
  })

program
  .command('restart')
  .description('Stop the running Clawboo dashboard server and start a fresh one on the same port.')
  .option('--no-open', "Don't open the browser after restarting.")
  .action((opts: { open: boolean }) => {
    runRestart(opts).catch(fail)
  })

program
  .command('backup [dest]')
  .description(
    'Back up the Clawboo SQLite database to a single checkpoint-consistent .db file ' +
      '(runs an online backup — safe while the server is live).',
  )
  .option('-f, --force', 'Overwrite the destination file if it already exists.')
  .action((dest: string | undefined, opts: { force: boolean }) => {
    runBackup(dest, opts).catch(fail)
  })

program.parse()
