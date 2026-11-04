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
 * instance onto a newer build are all awkward without them. A fourth, `open`,
 * signs a browser in to a running server that is locked with its access token.
 *
 * This file is presentation + Commander wiring only. The find/start/stop
 * primitives live in `lifecycle.ts` so they can be unit-tested (importing this
 * module would run `program.parse()`).
 */

import { Command, InvalidArgumentError } from 'commander'
import chalk from 'chalk'
import * as p from '@clack/prompts'
import ora, { type Ora } from 'ora'
import path from 'path'
import fs from 'fs'

import { resolveAccessTokenPath, resolveClawbooDir } from '@clawboo/config'

import { writeDatabaseBackup } from './backup'
import { VERSION } from './version'
import { nodeVersionError } from './node-version'
import { tailServerLog } from './server-log'
import { agentRuns, holdNote, reportUnstopped } from './stopReport'
import { shouldOfferRestart } from './versionCheck'
import {
  DEFAULT_STOP_WAIT_SECONDS,
  dashboardHost,
  dashboardUrl,
  discoverDashboard,
  fetchServerVersion,
  launcherAccessToken,
  mintLaunchCode,
  openReport,
  openUrlInBrowser,
  probeDashboard,
  probePort,
  readRuntimePort,
  removeRuntimePortFile,
  startDashboard,
  stopAfterAgentRuns,
  stopDashboard,
  uiPath,
  waitSecondsFrom,
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
    // Show WHY. The server is detached, so without this a failed boot is invisible
    // and the only signal is the timeout itself.
    if (outcome.logPath) {
      const lines = tailServerLog(outcome.logPath)
      if (lines.length > 0) {
        console.log()
        console.log(chalk.bold('Last lines from the server log:'))
        for (const line of lines) console.log(chalk.gray('  ' + line))
      }
      console.log()
      console.log(chalk.gray('Full log: ') + chalk.white(outcome.logPath))
    }
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
 * A Clawboo dashboard is running behind its access token, and this launcher
 * holds no token it accepts, so every `/api/*` call from here 401s. Say so
 * instead of behaving as if nothing were running, which would fork a second
 * server onto the same database, fail its readiness poll, and leave the first
 * one orphaned.
 */
function printGatedNotice(port: number): void {
  p.log.warn(
    chalk.yellow(`A Clawboo server is running on port ${port}, but it requires an access token.`),
  )
  const fromEnv = process.env['STUDIO_ACCESS_TOKEN']
  p.log.info(
    chalk.gray(
      fromEnv !== undefined && fromEnv.trim()
        ? "The STUDIO_ACCESS_TOKEN in this shell is not the server's token."
        : launcherAccessToken() !== null
          ? `The server was not started with the token in ${resolveAccessTokenPath()}. ` +
            "Set STUDIO_ACCESS_TOKEN to the server's token in this shell and run the command again."
          : "Set STUDIO_ACCESS_TOKEN to the server's token in this shell and run the command again.",
    ),
  )
  p.log.info(
    chalk.gray('Open ') +
      chalk.cyan.underline(`${dashboardUrl(port)}${uiPath() ? '' : '/'}?access_token=<token>`) +
      chalk.gray(' once to set it in your browser.'),
  )
}

/**
 * A server older than launch codes, reached with this shell's
 * STUDIO_ACCESS_TOKEN: the browser opened without a code still needs the
 * cookie, and the token is never put in a URL or command line from here. Say
 * how to set it.
 */
function printBrowserTokenHint(port: number): void {
  const fromEnv = process.env['STUDIO_ACCESS_TOKEN']
  if (fromEnv === undefined || !fromEnv.trim()) return
  p.log.info(
    chalk.gray('STUDIO_ACCESS_TOKEN is set. If the dashboard does not load, open ') +
      chalk.cyan.underline(`${dashboardUrl(port)}${uiPath() ? '' : '/'}?access_token=<token>`) +
      chalk.gray(' once in this browser.'),
  )
}

/** There was no browser to open: a server with no desktop, or no `xdg-open`. */
function printNoBrowserHint(): void {
  p.log.info(
    chalk.gray('For a one-time sign-in link to open in a browser yourself, run ') +
      chalk.white('clawboo open --print') +
      chalk.gray('.'),
  )
}

/**
 * Open the dashboard on `port` in this computer's browser. A locked server is
 * opened with a one-time launch code, so the browser gets the access cookie
 * without the token ever being in a URL. Only the plain address is printed:
 * nothing secret goes to the terminal. False when no browser could be opened.
 */
async function openDashboard(port: number): Promise<boolean> {
  const plain = dashboardUrl(port)
  const minted = await mintLaunchCode(port)
  const spinner = ora({ text: 'Opening Clawboo...', color: 'cyan' }).start()
  const opened = await openUrlInBrowser(minted?.gated ? dashboardUrl(port, minted.code) : plain)
  switch (openReport(minted, opened)) {
    case 'no-browser':
      spinner.warn(chalk.yellow('Could not open a browser on this computer.'))
      printNoBrowserHint()
      break
    case 'sign-in-unknown':
      // The server gave no sign-in link (a timeout, a 429, or a server older
      // than launch codes), so the browser may show the locked screen.
      spinner.warn(
        chalk.yellow('Clawboo opened at ') +
          chalk.cyan.underline(plain) +
          chalk.yellow(', but without a sign-in link.'),
      )
      p.log.info(
        chalk.gray('If it says the dashboard is locked, run ') +
          chalk.white('clawboo open') +
          chalk.gray(' to sign this browser in.'),
      )
      printBrowserTokenHint(port)
      break
    default:
      spinner.succeed(chalk.green('Clawboo opened at ') + chalk.cyan.underline(plain))
  }
  return opened
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

/** After a stop: say so when a hold this command placed may still keep new work back. */
function printHoldNote(outcome: StopOutcome, released: boolean | null): void {
  const note = holdNote(outcome, released)
  if (note) p.log.info(chalk.gray(note))
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
    // Infer from confirm() rather than widening to `symbol`. @clack/core 1.5
    // narrowed isCancel from `value is symbol` to `value is typeof CANCEL_SYMBOL`,
    // so excluding one unique symbol no longer removes a plain `symbol` and the
    // guard below stopped narrowing.
    let answer: Awaited<ReturnType<typeof p.confirm>>
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
  const free = !(await probePort(dashboardHost(), port, 500))
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

  const plainUrl = dashboardUrl(dashboardPort)

  // ── 4. Open browser ────────────────────────────────────────────────────────

  await openDashboard(dashboardPort)

  // ── 5. Success ─────────────────────────────────────────────────────────────

  console.log()
  p.outro(
    chalk.bold.hex('#E94560')('Clawboo is ready!') +
      '\n\n' +
      chalk.white('  What to do next:') +
      '\n' +
      chalk.gray('  •  Deploy a pre-built team or create your own') +
      '\n' +
      chalk.gray('  •  Open the Org chart to see your teams and agents') +
      '\n' +
      chalk.gray('  •  Browse the Marketplace for skills and team templates') +
      '\n' +
      chalk.gray('  •  Track token usage by team and agent') +
      '\n\n' +
      chalk.gray('  Clawboo:   ') +
      chalk.cyan.underline(plainUrl) +
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

// ─── Waiting for agent runs ───────────────────────────────────────────────────

interface StopWaitOptions {
  /** Stop now, without waiting for agent runs. */
  force?: boolean
  /** The longest wait for agent runs, in seconds. */
  wait?: number
}

function parseWaitSeconds(value: string): number {
  const seconds = waitSecondsFrom(value)
  if (seconds === null) throw new InvalidArgumentError('Give a whole number of seconds, 0 or more.')
  return seconds
}

function formatWait(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/**
 * Stop the server on `port` the way `clawboo stop` and `clawboo restart` do:
 * wait for the agent runs going to finish first (see `stopAfterAgentRuns`),
 * unless `--force`, with a spinner that says how many are left. Ctrl+C during
 * the wait exits and leaves the server running. Returns the stop's outcome and
 * the spinner, still spinning, for the caller to settle.
 */
async function stopWithReport(
  port: number,
  opts: StopWaitOptions,
  command: 'stop' | 'restart',
): Promise<{ outcome: StopOutcome; spinner: Ora; released: boolean | null }> {
  const stopping = `Stopping Clawboo on port ${port}...`
  const waitMs = (opts.wait ?? DEFAULT_STOP_WAIT_SECONDS) * 1000
  let spinner = ora({
    text: opts.force ? stopping : 'Checking for agent runs...',
    color: 'cyan',
  }).start()
  let waited = false
  const cancel = new AbortController()
  const onInterrupt = (): void => cancel.abort()
  process.once('SIGINT', onInterrupt)
  let result: Awaited<ReturnType<typeof stopAfterAgentRuns>>
  try {
    result = await stopAfterAgentRuns(port, {
      command,
      force: opts.force,
      waitMs,
      signal: cancel.signal,
      onWaiting: (running, leftMs) => {
        waited = true
        spinner.text =
          `Waiting for ${agentRuns(running)} to finish (${formatWait(leftMs)} left). ` +
          chalk.gray(`Ctrl+C cancels; clawboo ${command} --force stops now.`)
      },
      onStopping: (drain) => {
        if (drain?.status === 'timed-out') {
          spinner.warn(
            chalk.yellow(
              `Waited ${formatWait(waitMs)}; stopping ${agentRuns(drain.running)} still going.`,
            ),
          )
        } else if (drain?.status === 'gone') {
          // Its port closed: there is no server left to interrupt.
          spinner.warn(chalk.yellow('The server went away during the wait.'))
        } else if (waited) {
          spinner.succeed(chalk.green('Agent runs finished'))
        } else {
          spinner.text = stopping
          return
        }
        spinner = ora({ text: stopping, color: 'cyan' }).start()
      },
    })
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
  if (result.stop === null) {
    // The wait ended without a stop: cancelled, or a server whose runs could not
    // be seen. Say why, and whether its hold may still keep new work back.
    const report = reportUnstopped(result, command)!
    if (report.tone === 'fail') spinner.fail(chalk.yellow(report.text))
    else spinner.info(chalk.gray(report.text))
    for (const note of report.notes) p.log.info(chalk.gray(note))
    process.exit(report.exitCode)
  }
  return { outcome: result.stop, spinner, released: result.released }
}

// ─── `clawboo stop` ───────────────────────────────────────────────────────────

/**
 * Stop the instance the launcher would have attached to. Discovery is shared
 * with `clawboo`, so `CLAWBOO_API_PORT=<n> clawboo stop` targets one explicitly.
 *
 * Stopping something already stopped is not an error — this has to be safe to
 * run twice from a teardown script.
 *
 * Agent runs still going are waited for first (see `stopAfterAgentRuns`), unless
 * `--force`.
 */
async function runStop(opts: StopWaitOptions): Promise<void> {
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
    // A token-gated server there is alive too, so only a port with no Clawboo
    // answer at all counts as dead.
    const recorded = readRuntimePort()
    if (recorded !== null && (await probeDashboard(dashboardHost(), recorded, 1_500)) === 'none') {
      removeRuntimePortFile()
    }
    p.log.info(chalk.gray('No Clawboo server is running.'))
    return
  }

  const { outcome, spinner, released } = await stopWithReport(port, opts, 'stop')

  switch (outcome.status) {
    case 'stopped':
      spinner.succeed(
        chalk.green('Clawboo stopped') +
          chalk.gray(` (pid ${outcome.pid}${outcome.forced ? ', forced' : ''})`),
      )
      return
    case 'not-running':
      spinner.info(chalk.gray('No Clawboo server is running.'))
      printHoldNote(outcome, released)
      return
    default:
      spinner.fail(chalk.yellow(describeStopFailure(outcome)))
      printHoldNote(outcome, released)
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
async function runRestart(opts: { open: boolean } & StopWaitOptions): Promise<void> {
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
    const { outcome, spinner, released } = await stopWithReport(port, opts, 'restart')
    if (outcome.status === 'could-not-identify' || outcome.status === 'still-alive') {
      spinner.fail(chalk.yellow(describeStopFailure(outcome)))
      printHoldNote(outcome, released)
      printManualStopHint(port)
      // Deliberately do NOT start a replacement: a pinned start would throw on
      // the taken port, and an unpinned one would leave TWO dashboards running.
      process.exit(1)
    }
    spinner.succeed(chalk.green('Clawboo stopped'))
    printHoldNote(outcome, released)
    // Pin only if the port really freed — a `pnpm dev` supervisor can respawn
    // the server on the same port between our stop and our start. Unpinned, the
    // successor resolves its own port the way any boot does.
    if (!(await probePort(dashboardHost(), port, 500))) pinned = port
  }

  const started = await startAndReport({ port: pinned, verb: 'Restarting' })
  if (started === null) {
    // Only when a stop actually ran — with nothing running beforehand this is a
    // plain start failure and the existing message is already accurate.
    if (port !== null) printStoppedNotReplaced(port)
    process.exit(1)
  }

  const url = dashboardUrl(started)
  if (opts.open) await openDashboard(started)

  console.log()
  p.outro(
    chalk.bold.hex('#E94560')('Clawboo restarted') +
      chalk.gray(' v' + VERSION) +
      '\n\n' +
      chalk.gray('  Clawboo:   ') +
      chalk.cyan.underline(url),
  )
}

// ─── `clawboo open` ───────────────────────────────────────────────────────────

/**
 * Sign a browser in to the running server. Each run mints a fresh one-time
 * launch code, so it is also the way back in for a browser that lost its
 * cookie: the dashboard's locked screen names this command.
 *
 * `--print` writes the link to stdout instead, alone on its line so it can be
 * piped, for a browser `open` cannot reach: a server with no desktop, reached
 * through an SSH tunnel, or another browser on this computer.
 */
async function runOpen(opts: { print: boolean }): Promise<void> {
  const { port, gatedPort } = await discoverDashboard()
  if (port === null && gatedPort !== null) {
    printGatedNotice(gatedPort)
    process.exit(1)
  }
  if (port === null) {
    p.log.warn(chalk.yellow('No Clawboo server is running.'))
    p.log.info(chalk.gray('Start one with ') + chalk.white('clawboo') + chalk.gray('.'))
    process.exit(1)
  }

  if (!opts.print) {
    if (!(await openDashboard(port))) process.exit(1)
    return
  }

  const minted = await mintLaunchCode(port)
  if (minted?.gated) {
    console.log(dashboardUrl(port, minted.code))
    console.error(
      chalk.gray(
        'This link signs in one browser, once, within two minutes. On another computer, ' +
          "use this computer's address in place of 127.0.0.1.",
      ),
    )
    return
  }
  console.log(dashboardUrl(port))
  console.error(
    chalk.gray(
      minted === null
        ? 'This server could not make a one-time link, so this is its plain address. ' +
            'It may be older than this launcher; run clawboo restart to update it.'
        : 'This server has no access token, so its address needs no sign-in.',
    ),
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

  // Owner-only (0600) from the first byte, online and read-only against the live DB.
  const spinner = ora({ text: `Backing up ${source} → ${dest}`, color: 'cyan' }).start()
  try {
    await writeDatabaseBackup(source, dest)
  } catch (err) {
    spinner.fail(chalk.red('Backup failed'))
    throw err
  }
  spinner.succeed(chalk.green('Backup complete'))

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
  .description(
    'Run a team of AI agents on Claude Code, Codex, Hermes, OpenClaw or built-in agents.',
  )
  .version(VERSION)
  .option('--no-version-check', 'Skip comparing a running server against this launcher.')
  .option('-y, --yes', 'Restart an older running server without prompting.')
  .showHelpAfterError()
  // Node preflight for EVERY command, not just the default launch. This binary is
  // bundled as CJS and require()s ESM-only deps, so an unsupported Node fails with a
  // raw ERR_REQUIRE_ESM before any of our code runs. A hook here means `stop`,
  // `restart`, `backup` — and any future subcommand — inherit it automatically.
  .hook('preAction', () => {
    const versionError = nodeVersionError(process.version)
    if (versionError) {
      console.error(chalk.red('✖ ') + versionError)
      process.exit(1)
    }
  })

program.action((opts: LaunchOptions, command: Command) => {
  // Commander dispatches registered subcommands before reaching here and does
  // not reject excess operands, so a leftover operand is a subcommand name we
  // don't have. Without this `clawboo stopp` would quietly launch the dashboard
  // and open a browser — which is the opposite of what was asked for.
  const unknown = command.args[0]
  if (unknown !== undefined) program.error(`error: unknown command '${unknown}'`)
  run(opts).catch(fail)
})

const FORCE_HELP = 'Stop now, without waiting for agent runs to finish.'
const WAIT_HELP = `Wait at most this many seconds for agent runs to finish (default ${DEFAULT_STOP_WAIT_SECONDS}).`

program
  .command('stop')
  .description(
    'Stop the running Clawboo dashboard server, after the agent runs going have finished.',
  )
  .option('--force', FORCE_HELP)
  .option('--wait <seconds>', WAIT_HELP, parseWaitSeconds)
  .action((opts: StopWaitOptions) => {
    runStop(opts).catch(fail)
  })

program
  .command('restart')
  .description(
    'Stop the running Clawboo dashboard server, after the agent runs going have finished, ' +
      'and start a fresh one on the same port.',
  )
  .option('--no-open', "Don't open the browser after restarting.")
  .option('--force', FORCE_HELP)
  .option('--wait <seconds>', WAIT_HELP, parseWaitSeconds)
  .action((opts: { open: boolean } & StopWaitOptions) => {
    runRestart(opts).catch(fail)
  })

program
  .command('open')
  .description(
    'Open the running dashboard in your browser with a one-time sign-in link, ' +
      'for a browser that is not signed in.',
  )
  .option('--print', 'Print the one-time link instead of opening a browser.')
  .action((opts: { print?: boolean }) => {
    runOpen({ print: opts.print === true }).catch(fail)
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
