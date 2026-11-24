// What an administrator set for agents' screens, and the checks that go with it.
//
// Someone who runs Clawboo for several people decides, in the operator settings
// (lib/operatorSettings.ts: an environment variable or the operator file):
//
// - `computerLinks`: whether links to an agent's screen work at all (`on`),
//   only to watch (`view`), or not at all (`off`). A link is the one way into
//   a screen without the access token, so this is where that way is closed.
// - `xvncPath` and `cuaDriverPath`: the programs agents' displays and desktop
//   drivers run, named by path (a hardened or packaged build). With one named,
//   Clawboo runs that program and no other: not one it finds on PATH, not one
//   it installed, and it downloads none.
// - `disableDesktopToolsInstall`: no download of the desktop tools from the
//   dashboard at all.
// - `maxAgentDisplays`: how many agent displays run at once.
//
// Every read here fails closed: a setting that cannot be read turns links off,
// refuses a named program and refuses downloads. The server refuses to start on
// a value it cannot read anyway (initOperatorSettings), so this only matters if
// something changes under a running server.
//
// Linux only, like the screens themselves: the paths are POSIX paths.

import fs from 'node:fs'
import path from 'node:path'

import { operatorPin } from '../operatorSettings'
import type { LinkKind } from './links'

const posix = path.posix

// ─── Links ───────────────────────────────────────────────────────────────────

export type ComputerLinksSetting = 'on' | 'view' | 'off'

/** What the administrator allows for links to agents' screens. */
export function computerLinksSetting(): ComputerLinksSetting {
  try {
    const value = operatorPin('computerLinks')?.value
    return value === 'view' || value === 'off' ? value : 'on'
  } catch {
    return 'off'
  }
}

/**
 * Why a link of this kind may not be made or used here, or null when it may.
 * Checked when a link is made AND on every request that carries one, so a link
 * made before the setting changed stops working with it.
 */
export function linkKindRefusal(
  kind: LinkKind,
  setting: ComputerLinksSetting = computerLinksSetting(),
): string | null {
  if (setting === 'off') {
    return "Links to agents' screens are turned off by your administrator (CLAWBOO_COMPUTER_LINKS=off)."
  }
  if (setting === 'view' && kind === 'control') {
    return 'Control links are turned off by your administrator (CLAWBOO_COMPUTER_LINKS=view). View links still work.'
  }
  return null
}

// ─── Programs named by the administrator ─────────────────────────────────────

export type OperatorProgramKey = 'xvncPath' | 'cuaDriverPath'

export interface OperatorProgram {
  /** The path the administrator named. */
  path: string
  /** Why it may not run, or null when it may. */
  problem: string | null
}

/** What the trust check reads, so tests can stand in for the filesystem. */
export interface ProgramCheckDeps {
  lstat: (p: string) => fs.Stats
  realpath: (p: string) => string
  canExecute: (p: string) => boolean
  uid: number | null
}

const realDeps = (): ProgramCheckDeps => ({
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync.native(p),
  canExecute: (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
})

/** Owned by root or by the user running Clawboo. */
function trustedOwner(st: fs.Stats, uid: number | null): boolean {
  return st.uid === 0 || (uid !== null && st.uid === uid)
}

/**
 * Why the program at `file` may not be run, or null when it may.
 *
 * Clawboo runs it as the agents' user and, to check what it is, as itself. So
 * nobody but root or the user running Clawboo may be able to change it:
 *
 * - the path is the program itself, with no link anywhere in it, so the file
 *   checked is the file run, and nobody can point a link somewhere else later;
 * - it is a regular file that can be run;
 * - it and every folder above it belong to root or to this user, and none of
 *   them can be written by its group or by others (a folder that others can
 *   write lets them rename the program away and put their own in its place).
 */
export function programTrustProblem(
  file: string,
  deps: ProgramCheckDeps = realDeps(),
): string | null {
  if (!posix.isAbsolute(file) || posix.normalize(file) !== file) {
    return `${file} is not an absolute path written plainly.`
  }
  let real: string
  let st: fs.Stats
  try {
    real = deps.realpath(file)
    st = deps.lstat(file)
  } catch {
    return `${file} does not exist, or Clawboo cannot read it.`
  }
  if (real !== file) {
    return `${file} is a link, or sits in a folder that is a link (it leads to ${real}). Name the program itself.`
  }
  if (!st.isFile()) return `${file} is not a file.`
  if ((st.mode & 0o111) === 0 || !deps.canExecute(file)) return `${file} cannot be run.`
  if (!trustedOwner(st, deps.uid) || (st.mode & 0o022) !== 0) {
    return `${file} can be changed by a user other than root and the one running Clawboo. Make it owned by one of them and writable by its owner only.`
  }
  for (let dir = posix.dirname(file); ; dir = posix.dirname(dir)) {
    let d: fs.Stats
    try {
      d = deps.lstat(dir)
    } catch {
      return `${dir}, a folder above ${file}, cannot be read.`
    }
    if (!d.isDirectory() || !trustedOwner(d, deps.uid) || (d.mode & 0o022) !== 0) {
      return `${dir}, a folder above ${file}, can be changed by a user other than root and the one running Clawboo, who could put another program in its place.`
    }
    if (dir === '/') return null
  }
}

/** What the trust check reads when a caller passes nothing. Tests. */
let checkDepsForTests: ProgramCheckDeps | null = null

export function setProgramCheckDepsForTests(deps: ProgramCheckDeps | null): void {
  checkDepsForTests = deps
}

/**
 * The program the administrator named for `key`, with why it may not run, or
 * null when none is named. A name that cannot be read is a refusal, never a
 * fall back to another program.
 */
export function operatorProgram(
  key: OperatorProgramKey,
  deps: ProgramCheckDeps | undefined = checkDepsForTests ?? undefined,
): OperatorProgram | null {
  let named: string | null | undefined
  try {
    named = operatorPin(key)?.value
  } catch {
    return { path: '', problem: `The administrator's ${key} setting cannot be read.` }
  }
  if (!named) return null
  return { path: named, problem: programTrustProblem(named, deps) }
}

/**
 * Programs Clawboo installs itself that an administrator may name instead, by
 * launcher name. One map, read by both the spawn plan and Connect, so the two
 * never disagree about which program runs.
 */
const OPERATOR_NAMED: ReadonlyMap<string, OperatorProgramKey> = new Map([
  ['cua-driver', 'cuaDriverPath'],
])

/** The program an administrator named in place of Clawboo's own `launcher`, or null. */
export function operatorProgramForLauncher(
  launcher: string,
  deps?: ProgramCheckDeps,
): OperatorProgram | null {
  const key = OPERATOR_NAMED.get(launcher)
  return key ? operatorProgram(key, deps) : null
}

// ─── Downloads ───────────────────────────────────────────────────────────────

export type DesktopTool = 'tigervnc' | 'cuaDriver'

/** Why the dashboard may not download any desktop tool, or null when it may. */
export function desktopToolsInstallRefusal(): string | null {
  try {
    return operatorPin('disableDesktopToolsInstall')?.value === true
      ? 'Downloading the desktop tools is turned off by your administrator (CLAWBOO_DISABLE_DESKTOP_TOOLS_INSTALL).'
      : null
  } catch {
    return "The administrator's settings for the desktop tools cannot be read, so nothing is downloaded."
  }
}

/**
 * Why the dashboard may not download this desktop tool, or null when it may.
 * Turned off outright by `disableDesktopToolsInstall`; for one tool, by the
 * administrator naming that tool's program, since a downloaded copy would never
 * run beside it.
 */
export function desktopToolDownloadRefusal(tool: DesktopTool): string | null {
  const off = desktopToolsInstallRefusal()
  if (off) return off
  try {
    if (tool === 'tigervnc' && operatorPin('xvncPath')?.value) {
      return 'Your administrator named the Xvnc agents use (CLAWBOO_XVNC_PATH), so Clawboo downloads none.'
    }
    if (tool === 'cuaDriver' && operatorPin('cuaDriverPath')?.value) {
      return 'Your administrator named the Cua Driver agents use (CLAWBOO_CUA_DRIVER_PATH), so Clawboo downloads none.'
    }
    return null
  } catch {
    return "The administrator's settings for the desktop tools cannot be read, so nothing is downloaded."
  }
}

// ─── The display cap ─────────────────────────────────────────────────────────

/** Agent browsers allowed at once when nothing sets it (agentBrowsers.ts). */
const DEFAULT_BROWSER_CAP = 4

/**
 * How many agent displays may run at once: `maxAgentDisplays` when set, else
 * as many as agent browsers (`CLAWBOO_MAX_AGENT_BROWSERS`, 4 by default),
 * which was the only cap before. Separate from the cap on runs
 * (`CLAWBOO_MAX_CONCURRENT_RUNS`): a display stays up while its browser is
 * open, whether or not a run is.
 */
export function maxAgentDisplays(env: NodeJS.ProcessEnv = process.env): number {
  try {
    const pinned = operatorPin('maxAgentDisplays')?.value
    if (typeof pinned === 'number') return pinned
  } catch {
    // Unreadable: the browser cap, as before this setting existed.
  }
  return Number(env['CLAWBOO_MAX_AGENT_BROWSERS']) || DEFAULT_BROWSER_CAP
}
