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

import { existsSync } from 'node:fs'
import path from 'node:path'

import { findExecutable, isWindows } from '../platform'
import { resolveWindowsSpawn } from '../runtimes/winSpawn'

export interface ConnectorSpawnPlan {
  /** What is actually handed to the process spawner. */
  command: string
  args: string[]
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
  // An ABSOLUTE command needs no lookup, and looking it up anyway is wrong on
  // Windows: `where` searches PATH for a NAME and fails outright on a full path,
  // so an absolute command would report itself as missing. POSIX `which` happens
  // to accept one, which is exactly why this only ever broke on Windows.
  const preResolved =
    path.isAbsolute(launch.command) && existsSync(launch.command) ? launch.command : null
  const resolved = preResolved ?? findExecutable(launch.command)
  const command = resolved ?? launch.command
  const args = [...launch.args]

  // WE DO NOT PRE-ROUTE ON WINDOWS, and that is a correction rather than an
  // omission. The MCP SDK spawns through cross-spawn, which performs the whole
  // cmd.exe routing itself -- escaping each token and setting
  // windowsVerbatimArguments, which is the half that makes the escaping correct.
  // Rewriting the command to cmd.exe here would DEFEAT that: cross-spawn skips
  // its routing when the command is already an .exe, so nothing would set
  // verbatim and Node would re-quote an already-caret-escaped line. The
  // connector then fails to start. Handing cross-spawn the plain `npx.cmd` is
  // what makes it work.
  //
  // `resolveWindowsSpawn` is still used, for DISPLAY only: it produces the
  // cmd.exe line the operator will actually get, which is the thing consent is
  // being asked for.
  const shown = isWindows ? resolveWindowsSpawn({ command, args }) : { command, args }

  return {
    command,
    args,
    display: [shown.command, ...shown.args].map(displayToken).join(' '),
    unresolved: resolved === null,
  }
}
