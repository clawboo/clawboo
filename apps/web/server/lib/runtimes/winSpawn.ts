// Windows-safe spawn planning for the runtime CLI drivers (Codex, Hermes).
//
// We spawn with `shell: false` so an untrusted prompt passed as an argv element
// is NEVER interpreted by a shell on macOS/Linux or for a Windows `.exe` target.
// The one case that still needs care is a Windows `.cmd`/`.bat` shim: Node
// (>=18.20.2 / 20.12.2 / 22) refuses to spawn those without a shell (the
// CVE-2024-27980 fix throws EINVAL), so we route them through cmd.exe: the
// resolved command token double-quoted, and every untrusted argument quoted
// (CommandLineToArgvW boundaries) AND caret-escaped (cmd.exe metacharacters) so
// a prompt like `do X & calc.exe` cannot break out and chain a second command.
// Quoting the token is not sufficient for `%` and `!`, which cmd substitutes
// before quotes mean anything, so a path carrying either is refused outright.
//
// The escaping below implements cmd.exe's documented quoting rules — the
// CommandLineToArgvW argument-boundary rules plus caret-escaping of cmd.exe's
// metacharacters (https://qntm.org/cmd is the canonical write-up of both).
// Implemented inline because the rules are small and fixed, and pulling in a
// dependency for them isn't worth it.

import { isWindows } from '../platform'

const META_CHARS = /([()\][%!^"`<>&|;, *?])/g

/**
 * The two metacharacters double quotes CANNOT make literal in the program token.
 *
 * cmd.exe expands `%VAR%` in an EARLIER phase than the one that gives quotes
 * their meaning, so `"%TEMP%\tool.cmd"` is already substituted by the time the
 * quotes are read. `!VAR!` behaves the same way on a machine with delayed
 * expansion enabled. A caret cannot rescue either, because carets are processed
 * in that same later phase.
 *
 * An argument is safe (`escapeCmdArg` caret-escapes both, and its escape lands
 * before the batch body re-parses), but the program token is not, so a resolved
 * path carrying one is refused rather than launched. The sign-in path already
 * refuses such a binary upstream via `UNSAFE_BIN_CHARS` in `cliLoginPlans.ts`;
 * refusing here covers the driver paths, which resolve through
 * `resolveRuntimeBin` and reach no such filter.
 */
const EXPANDS_INSIDE_QUOTES = /[%!]/

const isBatch = (command: string): boolean => /\.(cmd|bat)$/i.test(command)

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

/** True when this command can only be spawned through the cmd.exe shim route. */
export function needsCmdShim(command: string): boolean {
  return isWindows && isBatch(command)
}

/**
 * Build the cmd.exe invocation for a Windows `.cmd`/`.bat` shim: the command
 * plus every argument quoted and caret-escaped into one `/c` line, with
 * `windowsVerbatimArguments` so Node does not re-quote the carefully-escaped
 * result. ONLY for commands `needsCmdShim` approves; everything else spawns as
 * plain argv and must never come near this builder, so that a spawn call is
 * always exactly one of the two modes rather than a merge of both.
 */
export function buildCmdShimPlan(plan: { command: string; args: string[] }): WinSpawnPlan {
  const comspec = process.env['ComSpec'] || process.env['comspec'] || 'cmd.exe'
  if (EXPANDS_INSIDE_QUOTES.test(plan.command)) {
    throw new Error(`refusing to launch a Windows shim whose path contains % or !: ${plan.command}`)
  }
  // The command token is QUOTED, not caret-escaped. Real double quotes are what
  // cmd.exe honours in the program position (with /s the outer quotes strip and
  // a `"C:\path with spaces\tool.cmd" args…` line runs the quoted program), and
  // they make the SUBSTITUTION-phase metacharacters literal, so a path carrying
  // `&`, `^`, `|`, `<`, `>` or parentheses stays one literal token. A quote
  // inside the path itself cannot occur: `"` is not a legal character in a
  // Windows file name, so nothing the filesystem resolves can close the wrapping
  // early. `%` and `!` are the exception and are refused above.
  const shellCommand = [`"${plan.command}"`, ...plan.args.map(escapeCmdArg)].join(' ')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * Resolve how to spawn a command safely. On non-Windows, or for a Windows `.exe`
 * target, the command + args are returned unchanged (spawned with `shell: false`,
 * so argv is never shell-interpreted). For a Windows `.cmd`/`.bat` shim, route
 * through cmd.exe via `buildCmdShimPlan`.
 */
export function resolveWindowsSpawn(plan: { command: string; args: string[] }): WinSpawnPlan {
  if (!needsCmdShim(plan.command)) {
    return { command: plan.command, args: plan.args }
  }
  return buildCmdShimPlan(plan)
}
