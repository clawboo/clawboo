// The ONE place a connector's spawn is decided.
//
// The consent dialog and the actual spawn read the SAME plan, and that is the
// entire reason this is a function rather than two similar code paths. A dialog
// that shows `npx -y some-server@1.2.3` while the process that runs is
// `C:\Windows\System32\cmd.exe /d /s /c "..."` is asking for consent to
// something other than what happens.
//
// NEVER shell: true. The catalog supplies `args` as an array, and handing that
// array to a shell as a string turns a registry snapshot into arbitrary command
// execution -- an arg containing `& calc.exe` would run. On Windows a `.cmd`
// shim genuinely cannot be spawned directly, so it is routed through cmd.exe by
// `resolveWindowsSpawn`, which escapes each token individually and sets
// windowsVerbatimArguments. That is a different thing from a shell.

import { findExecutable, isWindows } from '../platform'
import { resolveWindowsSpawn } from '../runtimes/winSpawn'

export interface ConnectorSpawnPlan {
  /** What is actually handed to the process spawner. */
  command: string
  args: string[]
  /** Windows cmd.exe routing needs the raw command line preserved. */
  windowsVerbatimArguments?: boolean
  /**
   * What the operator is shown, and it is the RESOLVED form.
   *
   * Deliberately not the catalog's `npx`: an absolute path is the difference
   * between "some npx" and "this npx", and on Windows it is the difference
   * between a shim and the cmd.exe line that will really execute.
   */
  display: string
  /** True when the binary could not be found on PATH. */
  unresolved: boolean
}

/** Quote a token for DISPLAY only. Never fed to a shell. */
function displayToken(token: string): string {
  return /[\s"'`$&|;<>(){}[\]*?!\\]/.test(token) ? JSON.stringify(token) : token
}

/**
 * Resolve a catalog launch into an exact, inspectable spawn.
 *
 * `unresolved` rather than a throw: a missing binary is an ordinary,
 * user-fixable condition ("install Node"), and the caller can render that far
 * better than an exception can. The plan still carries the original command so
 * the message can name what was looked for.
 */
export function planConnectorSpawn(launch: {
  command: string
  args: readonly string[]
}): ConnectorSpawnPlan {
  const resolved = findExecutable(launch.command)
  const command = resolved ?? launch.command
  const args = [...launch.args]

  // On a non-Windows host, or for a non-batch target, this returns the plan
  // unchanged -- so the common case carries no Windows machinery at all.
  const spawn = resolveWindowsSpawn({ command, args })

  const display = isWindows
    ? [spawn.command, ...spawn.args].map(displayToken).join(' ')
    : [command, ...args].map(displayToken).join(' ')

  return {
    command: spawn.command,
    args: spawn.args,
    ...(spawn.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    display,
    unresolved: resolved === null,
  }
}
