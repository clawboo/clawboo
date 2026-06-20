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
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Well-known dirs where CLIs installed via `pip install --user` / `pipx` land
 * but which a GUI-launched or `npx`-spawned server process frequently does NOT
 * have on its PATH. Notably Hermes (`hermes-agent`) installs to the Python
 * user-site bin — `~/Library/Python/<X.Y>/bin` on macOS, `~/.local/bin` on
 * Linux, `%APPDATA%\Python\Python<XY>\Scripts` on Windows.
 */
export function extraBinDirs(): string[] {
  const home = os.homedir()
  const dirs = [path.join(home, '.local', 'bin')]
  try {
    if (process.platform === 'darwin') {
      const pyRoot = path.join(home, 'Library', 'Python')
      for (const v of readdirSync(pyRoot)) dirs.push(path.join(pyRoot, v, 'bin'))
    } else if (isWindows) {
      const appdata = process.env['APPDATA']
      if (appdata) {
        const pyRoot = path.join(appdata, 'Python')
        for (const v of readdirSync(pyRoot)) dirs.push(path.join(pyRoot, v, 'Scripts'))
      }
    }
  } catch {
    /* the Python root may not exist — the curated dirs above still apply */
  }
  return dirs
}

/**
 * Resolve a CLI to an absolute path: PATH first (via `findExecutable`), then the
 * `extraBinDirs()` user-install locations. Returns the absolute path or `null`.
 *
 * This is what makes Hermes discoverable: its `hermes` binary lives in the
 * Python user-site bin, off the dashboard server's PATH, so a bare PATH probe
 * (and a bare `spawn('hermes')`) both miss it. Health checks AND the spawn
 * `command` use the resolved absolute path instead. `extraDirs` is injectable
 * for tests.
 */
export function resolveRuntimeBin(
  name: string,
  extraDirs: string[] = extraBinDirs(),
): string | null {
  const onPath = findExecutable(name)
  if (onPath) return onPath
  const candidates = isWindows ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  for (const dir of extraDirs) {
    for (const file of candidates) {
      const full = path.join(dir, file)
      if (existsSync(full) && isExecutableFile(full)) return full
    }
  }
  return null
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
