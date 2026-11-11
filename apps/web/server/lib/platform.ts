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
//   sent Windows users to the OpenClaw install screen even after a
//   successful manual `npm install -g openclaw@...`.

import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ownedRuntimeBin } from './runtimeFolder'

export const isWindows = process.platform === 'win32'

/**
 * Cross-platform `which`. Returns the absolute path to the first match,
 * or `null` if not found. On Windows uses `where` (which can return
 * multiple paths separated by CRLF — we take the first).
 */
/**
 * Choose the spawnable candidate from `where` output.
 *
 * PATHEXT order, falling back to whatever came first. The fallback matters: a
 * path with no recognised extension may still be a real executable, and
 * returning null because we did not recognise it would be worse than returning
 * the thing Windows itself listed.
 */
function pickWindowsExecutable(lines: string[]): string | undefined {
  const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'))
  for (const ext of exts) {
    const hit = lines.find((l) => l.toLowerCase().endsWith(ext))
    if (hit) return hit
  }
  return lines[0]
}

export function findExecutable(name: string): string | null {
  try {
    const cmd = isWindows ? 'where' : 'which'
    // `timeout` is load-bearing: this runs SYNCHRONOUSLY (it blocks the single-
    // threaded server), and on Windows `where` can be slow under Defender
    // real-time scanning. An unbounded spawn here froze `/api/system/status`
    // past the client timeout on Windows CI runners (and would stall the
    // OpenClaw setup for real users). `where`/`which` is normally
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
    const lines = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.length === 0) return null
    // On Windows `where` returns EVERY match, and for an npm-installed shim that
    // is both `npx` (an extensionless POSIX shell script, not executable by
    // CreateProcess) and `npx.cmd`. Taking the first line verbatim can therefore
    // hand a caller a path that cannot be spawned at all, and one that
    // `resolveWindowsSpawn` will not route through cmd.exe either, because its
    // `.cmd|.bat` test does not match. Prefer a real executable extension.
    return (isWindows ? pickWindowsExecutable(lines) : lines[0]) ?? null
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
 * Resolve a CLI to an absolute path: Clawboo's own runtimes folder first (the
 * launcher an install from Clawboo wrote, see `runtimeFolder.ts`), then PATH (via
 * `findExecutable`), then the `extraBinDirs()` user-install locations. Returns
 * the absolute path or `null`.
 *
 * The runtimes folder comes first so the copy Clawboo installed, on the
 * interpreter it was installed with, wins over an older global one; a global
 * install keeps working when Clawboo has none of its own.
 *
 * The user-install dirs are what make a pip-installed Hermes discoverable: its
 * `hermes` binary lives in the Python user-site bin, off the dashboard server's
 * PATH, so a bare PATH probe (and a bare `spawn('hermes')`) both miss it. Health
 * checks AND the spawn `command` use the resolved absolute path instead.
 * `extraDirs` and `env` are injectable for tests.
 */
export function resolveRuntimeBin(
  name: string,
  extraDirs: string[] = extraBinDirs(),
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const owned = ownedRuntimeBin(name, env)
  if (owned) return owned
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

export interface PythonCandidate {
  /** Absolute path to the interpreter. */
  bin: string
  /** The Python 3.x MINOR version (e.g. 12 for Python 3.12). */
  minor: number
  /** Human-readable "3.<minor>". */
  version: string
}

/** The Python 3 minor versions a package installs on, both ends included:
 *  `>=3.11,<3.14` is `{ minMinor: 11, maxMinor: 13 }`. A `maxMinor` of
 *  `Infinity` means no upper bound. */
export interface PythonRange {
  minMinor: number
  maxMinor: number
}

/**
 * PURE: from the discovered interpreters, pick the newest one inside `range`, or
 * null when none is. Newest overall would let a 3.14 beat a 3.12, and
 * `hermes-agent` does not install on 3.14. Exported for tests.
 */
export function pickPython(found: PythonCandidate[], range: PythonRange): PythonCandidate | null {
  let compatible: PythonCandidate | null = null
  for (const c of found) {
    const inRange = c.minor >= range.minMinor && c.minor <= range.maxMinor
    if (inRange && (!compatible || c.minor > compatible.minor)) compatible = c
  }
  return compatible
}

/**
 * PURE: the interpreter names to probe, newest first. The version-specific names
 * cover the range plus one step past each end, so an error can name the
 * out-of-range Python a user really has (a 3.14 or a 3.10). The bare `python3` and
 * `python` come last. With no upper bound, only the bare names are probed.
 * Exported for tests.
 */
export function pythonCandidateNames(range: PythonRange): string[] {
  const versioned: string[] = []
  if (Number.isFinite(range.maxMinor)) {
    for (let m = range.maxMinor + 1; m >= Math.max(range.minMinor - 1, 0); m--) {
      versioned.push(`python3.${m}`)
    }
  }
  return [...versioned, 'python3', 'python']
}

function pythonMinorOf(bin: string): number | null {
  try {
    // A bounded one-liner (mirrors findExecutable's 5 s cap): print the 3.x minor
    // (or -1 for a Python 2), so a too-old interpreter is detected, not spawned at.
    const out = execFileSync(
      bin,
      ['-c', 'import sys;print(sys.version_info[1] if sys.version_info[0]==3 else -1)'],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    ).trim()
    const n = Number(out)
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

/**
 * Resolve a Python 3 interpreter inside `range`, probing version-specific
 * binaries (python3.14 down to python3.10 for Hermes) before the bare `python3`.
 * That covers two cases: a fresh macOS whose `python3` is the Xcode Command Line
 * Tools Python 3.9, and a machine whose newest Python (say 3.14) is past the top
 * of the range while a 3.12 is also installed. `hermes-agent` requires
 * >=3.11,<3.14. Returns the newest interpreter inside the range (null when none
 * is) and every interpreter found, newest first, so the caller can name them in
 * its error. Spawns `which` + a bounded `<py> -c ...` per candidate.
 */
export function resolvePython(range: PythonRange): {
  compatible: PythonCandidate | null
  found: PythonCandidate[]
} {
  const found: PythonCandidate[] = []
  const seen = new Set<string>()
  for (const name of pythonCandidateNames(range)) {
    const bin = resolveRuntimeBin(name)
    if (!bin || seen.has(bin)) continue
    seen.add(bin)
    const minor = pythonMinorOf(bin)
    if (minor !== null) found.push({ bin, minor, version: `3.${minor}` })
  }
  found.sort((a, b) => b.minor - a.minor)
  return { compatible: pickPython(found, range), found }
}
