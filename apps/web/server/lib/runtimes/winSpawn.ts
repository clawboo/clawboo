// Windows-safe spawn planning for the runtime CLI drivers (Codex, Hermes).
//
// We spawn with `shell: false` so an untrusted prompt passed as an argv element
// is NEVER interpreted by a shell on macOS/Linux or for a Windows `.exe` target.
// The one case that still needs care is a Windows `.cmd`/`.bat` shim: Node
// (>=18.20.2 / 20.12.2 / 22) refuses to spawn those without a shell (the
// CVE-2024-27980 fix throws EINVAL), so we route them through cmd.exe — and then
// every untrusted argument MUST be quoted (CommandLineToArgvW boundaries) AND
// caret-escaped (cmd.exe metacharacters) so a prompt like `do X & calc.exe`
// cannot break out and chain a second command.
//
// The escaping below implements cmd.exe's documented quoting rules — the
// CommandLineToArgvW argument-boundary rules plus caret-escaping of cmd.exe's
// metacharacters (https://qntm.org/cmd is the canonical write-up of both).
// Implemented inline because the rules are small and fixed, and pulling in a
// dependency for them isn't worth it.

import { isWindows } from '../platform'

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

const isBatch = (command: string): boolean => /\.(cmd|bat)$/i.test(command)

/** Caret-escape cmd.exe metacharacters in a command token (the shim path). */
function escapeCommandToken(token: string): string {
  return token.replace(META_CHARS, '^$1')
}

/**
 * Escape ONE argument for a cmd.exe command line: double the backslash runs that
 * precede a quote and the closing quote, wrap the whole arg in double quotes,
 * then caret-escape every cmd.exe metacharacter. The escape is applied TWICE
 * because cmd.exe processes a batch-file invocation an extra time — so a single
 * pass would leave a live metacharacter on the second parse.
 */
export function escapeCmdArg(arg: string): string {
  let s = `${arg}`
  s = s.replace(/(\\*)"/g, '$1$1\\"') // backslashes before a quote: double them, escape the quote
  s = s.replace(/(\\*)$/, '$1$1') // trailing backslashes: double them (before the closing quote)
  s = `"${s}"`
  s = s.replace(META_CHARS, '^$1')
  s = s.replace(META_CHARS, '^$1') // double-escape: the target is a .cmd/.bat (cmd re-parses)
  return s
}

export interface WinSpawnPlan {
  command: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

/**
 * Resolve how to spawn a command safely. On non-Windows, or for a Windows `.exe`
 * target, the command + args are returned unchanged (spawned with `shell: false`,
 * so argv is never shell-interpreted). For a Windows `.cmd`/`.bat` shim, route
 * through cmd.exe with the command + every argument quoted and caret-escaped, and
 * `windowsVerbatimArguments` so Node does not re-quote the carefully-escaped line.
 */
export function resolveWindowsSpawn(plan: { command: string; args: string[] }): WinSpawnPlan {
  if (!isWindows || !isBatch(plan.command)) {
    return { command: plan.command, args: plan.args }
  }
  const comspec = process.env['ComSpec'] || process.env['comspec'] || 'cmd.exe'
  const shellCommand = [escapeCommandToken(plan.command), ...plan.args.map(escapeCmdArg)].join(' ')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  }
}
