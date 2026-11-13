// Turning agent isolation on copies the agents' existing state into agent
// space once (design 4.10): each runtime home (Hermes memory and skills, Codex
// sessions) and each team folder. Not Clawboo Native's homes, and from a
// runtime home no sign-in or key file (`auth.json`, `.env`) and not Hermes's
// `config.yaml`: before isolation those were copies of the operator's own
// logins, saved keys and settings. A team folder is copied whole. The
// originals stay where they are, so turning the setting off again is the
// rollback.
//
// The server reads the originals as itself: they sit in its own folders. Those
// folders were written by agents that ran as the server's user, though, so the
// copy trusts nothing in them:
// - a link is never followed and never copied (it could point at the vault);
// - a regular file with more than one hard link is skipped and reported (it
//   could BE the database, linked in under another name);
// - each file is opened without following a link and checked to be the file
//   that was listed.
// The copy lands under a temporary name and is renamed into place when whole,
// so a crash mid-copy leaves nothing that looks finished.

import fs from 'node:fs'
import path from 'node:path'

import { O_NOFOLLOW } from '../../agentHost/fsOps'
import {
  agentAppendFile,
  agentMkdir,
  agentRemove,
  agentRename,
  agentStat,
  agentWriteFile,
} from './agentFs'
import { MAX_WRITE_BYTES } from './protocol'

export interface CopyInItem {
  from: string
  to: string
  /** A runtime's home (which runtime), or a team folder. Only a runtime home
   *  leaves files out (see `leftOut`). */
  kind: { runtime: string } | 'team'
  /** The source folder as planned (device and inode). The copy refuses a
   *  source that is no longer this folder, such as one reached through a
   *  parent swapped for a link since. */
  planned?: { dev: number; ino: number }
}

export interface CopyInReport {
  copied: string[]
  /** Already there: the copy happened on an earlier start. */
  present: string[]
  /** Files and links left out on purpose (a link, a hard-linked file). */
  skipped: { path: string; reason: string }[]
  /** Whole items that could not be copied; tried again on the next start. */
  failed: { path: string; reason: string }[]
}

const STAGING = '.clawboo-copying'

/** Files never carried out of a runtime home, at any depth: sign-ins and keys
 *  the server put there before isolation came from the operator's own logins
 *  and vault; the agent user gets its own, and runs write what they need. */
const NEVER_COPIED = new Set(['auth.json', '.env'])

/** Why `rel` (a path inside a copied item) is left out, or null to copy it.
 *  A team folder keeps everything: its `.env` is the project's own settings,
 *  which nothing writes again. */
function leftOut(kind: CopyInItem['kind'], rel: string): string | null {
  if (kind === 'team') return null
  if (NEVER_COPIED.has(path.basename(rel))) return 'a sign-in or key file, written again per run'
  // Hermes's settings in its home were seeded from the operator's own, and can
  // hold a provider's `api_key`. With isolation on they are never seeded:
  // each run writes Clawboo's block into a fresh one.
  if (kind.runtime === 'hermes' && rel === 'config.yaml') {
    return "Hermes settings seeded from the operator's own, which can hold a provider key"
  }
  return null
}

/** Clawboo Native's runtime id, which names its homes' folder under `runtimes/`
 *  (`runtimeIdentityHomePath('clawboo-native', ...)`; the descriptor's id). */
export const NATIVE_RUNTIME_ID = 'clawboo-native'

/** Every copy to make: runtime homes and team folders, by their folder names. */
export function planCopyIn(opts: {
  dataDir: string
  agentRuntimesRoot: string
  workDir: string
  /** Team folders' previous parents: `<data>/workspaces`, the old work folder's `teams/`. */
  teamRoots: string[]
  /** Whether a team folder under a root is to be copied (default: every one). */
  keepTeam?: (root: string, name: string) => boolean
}): CopyInItem[] {
  const items: CopyInItem[] = []
  const item = (kind: CopyInItem['kind'], from: string, to: string): void => {
    try {
      const st = fs.lstatSync(from)
      if (st.isDirectory()) items.push({ from, to, kind, planned: { dev: st.dev, ino: st.ino } })
    } catch {
      /* gone since it was listed */
    }
  }
  const realDirs = (dir: string): string[] => {
    // A source root that is a link is never listed: `<data>/workspaces` pointing
    // at a private folder would otherwise send that folder's contents into
    // agent space. Its entries are checked the same way (`isDirectory` on a
    // directory entry is false for a link).
    if (!isRealDirectory(dir)) return []
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  const runtimes = path.join(opts.dataDir, 'runtimes')
  for (const rt of realDirs(runtimes)) {
    // Clawboo Native's homes hold its conversation history, which stays in the
    // data folder: its model loop is server code and no agent process uses it.
    if (rt === NATIVE_RUNTIME_ID) continue
    for (const agent of realDirs(path.join(runtimes, rt))) {
      item(
        { runtime: rt },
        path.join(runtimes, rt, agent),
        path.join(opts.agentRuntimesRoot, rt, agent),
      )
    }
  }
  const seen = new Set<string>()
  for (const root of opts.teamRoots) {
    for (const team of realDirs(root)) {
      if (seen.has(team) || (opts.keepTeam && !opts.keepTeam(root, team))) continue
      seen.add(team)
      item('team', path.join(root, team), path.join(opts.workDir, 'teams', team))
    }
  }
  return items
}

/** Copy each item that is not in agent space yet. Never throws for one item. */
export async function copyIntoAgentSpace(items: CopyInItem[]): Promise<CopyInReport> {
  const report: CopyInReport = { copied: [], present: [], skipped: [], failed: [] }
  for (const item of items) {
    try {
      if (await agentStat(item.to)) {
        report.present.push(item.to)
        continue
      }
      const staging = `${item.to}${STAGING}`
      await agentRemove(staging)
      await agentMkdir(path.dirname(item.to))
      await copyTree(item.from, staging, report, item.kind, '', item.planned)
      await agentRename(staging, item.to)
      report.copied.push(item.to)
    } catch (err) {
      report.failed.push({
        path: item.from,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return report
}

/** A real folder at `p`: not a link, not missing. */
function isRealDirectory(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Throw unless `p` is still the folder that was checked (`expected`): not a
 *  link, same device and inode. Run after every wait and before each path built
 *  on `p` is used, so a folder swapped for a link meanwhile is not followed. */
function assertSameFolder(p: string, expected: fs.Stats): void {
  const now = fs.lstatSync(p)
  if (!now.isDirectory() || now.dev !== expected.dev || now.ino !== expected.ino) {
    throw new Error(`${p} changed while it was being copied`)
  }
}

async function copyTree(
  src: string,
  dst: string,
  report: CopyInReport,
  kind: CopyInItem['kind'],
  /** `src` relative to the item's folder ('' at its top). */
  rel: string,
  planned?: { dev: number; ino: number },
): Promise<void> {
  const st = fs.lstatSync(src)
  if (!st.isDirectory()) throw new Error(`${src} is not a folder`)
  if (planned && (st.dev !== planned.dev || st.ino !== planned.ino)) {
    throw new Error(`${src} changed while it was being copied`)
  }
  await agentMkdir(dst, { mode: 0o700 })
  assertSameFolder(src, st)
  for (const name of fs.readdirSync(src).sort()) {
    const from = path.join(src, name)
    const to = path.join(dst, name)
    // The copy of the previous entry waited on the host; `src` may have been
    // swapped since, and `lstat` follows a link anywhere but the last part.
    assertSameFolder(src, st)
    let e: fs.Stats
    try {
      e = fs.lstatSync(from)
    } catch {
      continue
    }
    const entryRel = rel === '' ? name : `${rel}/${name}`
    if (e.isDirectory()) {
      await copyTree(from, to, report, kind, entryRel)
    } else if (e.isFile()) {
      const why = leftOut(kind, entryRel)
      if (why) {
        report.skipped.push({ path: from, reason: why })
        continue
      }
      if (e.nlink > 1) {
        report.skipped.push({
          path: from,
          reason:
            'it has more than one hard link, so it could be one of Clawboo private files under another name',
        })
        continue
      }
      await copyFile(from, to, e)
    } else {
      report.skipped.push({
        path: from,
        reason: e.isSymbolicLink() ? 'a link' : 'not a regular file',
      })
    }
  }
}

async function copyFile(from: string, to: string, listed: fs.Stats): Promise<void> {
  const fd = fs.openSync(from, fs.constants.O_RDONLY | O_NOFOLLOW)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || st.ino !== listed.ino || st.dev !== listed.dev || st.nlink > 1) {
      throw new Error(`${from} changed while it was being copied`)
    }
    const mode = st.mode & 0o100 ? 0o700 : 0o600
    const chunk = Buffer.alloc(Math.min(MAX_WRITE_BYTES, 4 * 1024 * 1024))
    let first = true
    let pos = 0
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos)
      if (n === 0 && !first) break
      const data = chunk.subarray(0, n)
      if (first) await agentWriteFile(to, data, { mode })
      else await agentAppendFile(to, data, { mode })
      first = false
      pos += n
      if (n === 0) break
    }
  } finally {
    fs.closeSync(fd)
  }
}
