// Tiny cross-platform helpers for invoking shell-shim binaries (npm,
// pnpm, openclaw) and discovering executables in PATH.
//
// Why this exists: Node's child_process spawn/execFile on Windows does
// NOT auto-resolve `.cmd` extensions when given a bare name like 'npm'
// (since npm on Windows is actually npm.cmd — a batch wrapper). Bypassing
// this helper causes ENOENT on Windows even when the tool IS installed.
// Symmetrically, `which` is a Unix command; Windows uses `where`.
//
// Use `findExecutable` when you need the full absolute path to a tool
// (preferred — explicit, no PATH-resolution surprises at spawn time).
// Use `resolveShimName` only when you must invoke a known shim by name
// (e.g., for `spawn('npm', ...)` style calls).
//
// Bugs this prevents (regression history):
// - v0.1.3 spawn('npm', ['install', '-g', 'openclaw@latest']) threw
//   `Error: spawn npm ENOENT` on Windows. Reported by a user running
//   `npx clawboo` on Windows; blocked the entire onboarding flow.
// - v0.1.3 execFileSync('which', ['openclaw']) threw silently on
//   Windows (catch returned `installed: false`). Onboarding always
//   routed Windows users to InstallStep even after a successful
//   manual `npm install -g openclaw@...`.

import { execFileSync } from 'node:child_process'

export const isWindows = process.platform === 'win32'

/**
 * Cross-platform `which`. Returns the absolute path to the first match,
 * or `null` if not found. On Windows uses `where` (which can return
 * multiple paths separated by CRLF — we take the first).
 */
export function findExecutable(name: string): string | null {
  try {
    const cmd = isWindows ? 'where' : 'which'
    // `timeout` is load-bearing: this runs SYNCHRONOUSLY (it blocks the single-
    // threaded server), and on Windows `where` can be slow under Defender
    // real-time scanning. An unbounded spawn here froze `/api/system/status`
    // past the client timeout on Windows CI runners (and would stall the
    // onboarding DetectStep for real users). `where`/`which` is normally
    // <200 ms, so a 5 s cap never trips in practice but bounds the worst case;
    // on timeout it throws → caught below → treated as "not found".
    // `windowsHide` suppresses the cmd.exe console flash (matches our other
    // Windows spawns).
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    }).trim()
    if (!out) return null
    // `where` on Windows may return multiple paths; first one wins.
    const first = out.split(/\r?\n/)[0]
    return first ? first.trim() : null
  } catch {
    return null
  }
}

/**
 * Resolve a shell-shim binary name (npm, pnpm, openclaw) to the actual
 * executable name. On Windows, npm-CLI tools install as `<name>.cmd`
 * batch wrappers; Node's spawn won't find them by bare name.
 *
 * Prefer `findExecutable` + spawn-the-full-path when possible. Use this
 * only for callers that hardcode the binary name.
 */
export function resolveShimName(name: string): string {
  return isWindows ? `${name}.cmd` : name
}
