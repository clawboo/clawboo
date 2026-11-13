// Whether this Hermes has its ACP mode, asked of Hermes itself: `hermes acp
// --check` imports the ACP dependencies and exits 0 ("Hermes ACP check OK"). A
// Hermes installed without the `acp` extra exits 1 with "ACP dependencies not
// installed.", and one too old to have the `acp` command fails its argument parse
// ("invalid choice: 'acp'"). Anything else (a crash, a timeout, no Hermes at all)
// tells nothing either way.
//
// The check runs in a throwaway HERMES_HOME, removed afterwards. Hermes loads the
// plugins, MCP servers and hooks its home configures before any agent command,
// and seeds the home with files, so the person's own home is never used.

import type { ChildProcess } from 'node:child_process'
import path from 'node:path'

import { isWindows, resolveRuntimeBin } from '../platform'
import { buildChildEnv } from './childEnv'
import { makeThrowawayRuntimeHome, removeThrowawayRuntimeHome } from './identityHome'
import { killProcessTree } from './killTree'
import { spawnAgentProcess } from './spawner'
import { registerRuntimeChild, unregisterRuntimeChild } from './subprocess'
import { resolveWindowsSpawn } from './winSpawn'

/** Python imports make the check take a few seconds on a slow machine. */
export const HERMES_ACP_CHECK_TIMEOUT_MS = 30_000

const MAX_OUTPUT = 16 * 1024

/** true: this Hermes has ACP. false: it lacks it. null: the check could not tell. */
export function classifyHermesAcpCheck(code: number | null, output: string): boolean | null {
  if (code === 0) return true
  if (/ACP dependencies not installed/i.test(output)) return false
  if (/invalid choice: '?acp'?/i.test(output)) return false
  return null
}

export interface HermesAcpCheckOptions {
  /** The command that starts Hermes (default: the resolved `hermes`). */
  command?: string
  /** Test seam: the args before `acp --check` (e.g. a fake Hermes script). */
  args?: string[]
  timeoutMs?: number
}

/** Run `hermes acp --check` and read its answer. Never throws; the child is
 *  always reaped and the throwaway home removed. */
export async function runHermesAcpCheck(opts: HermesAcpCheckOptions = {}): Promise<boolean | null> {
  const command = opts.command ?? resolveRuntimeBin('hermes')
  if (!command) return null
  let home: string
  try {
    home = await makeThrowawayRuntimeHome('clawboo-hermes-acp-check-')
  } catch {
    return null
  }
  try {
    return await checkIn(command, opts, home)
  } finally {
    await removeThrowawayRuntimeHome(home).catch(() => undefined)
  }
}

function checkIn(
  command: string,
  opts: HermesAcpCheckOptions,
  home: string,
): Promise<boolean | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      const plan = resolveWindowsSpawn({
        command,
        args: [...(opts.args ?? []), 'acp', '--check'],
      })
      const binDir = path.isAbsolute(command) ? path.dirname(command) : null
      // As the agent user when agents run as their own OS user, like the runs it
      // decides for; a refused start (the agent host is down) tells nothing.
      child = spawnAgentProcess({
        kind: 'probe',
        command: plan.command,
        args: plan.args,
        env: buildChildEnv({
          HERMES_HOME: home,
          ...(binDir ? { PATH: `${binDir}${path.delimiter}${process.env['PATH'] ?? ''}` } : {}),
        }),
        windowsHide: isWindows,
        // A process-group leader, so a timeout's reap takes any grandchildren too.
        detached: !isWindows,
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve(null)
      return
    }
    registerRuntimeChild(child)

    let settled = false
    let output = ''
    const finish = (value: boolean | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unregisterRuntimeChild(child)
      resolve(value)
    }
    const timer = setTimeout(() => {
      killProcessTree(child)
      finish(null)
    }, opts.timeoutMs ?? HERMES_ACP_CHECK_TIMEOUT_MS)
    timer.unref()

    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(classifyHermesAcpCheck(code, output)))
  })
}
