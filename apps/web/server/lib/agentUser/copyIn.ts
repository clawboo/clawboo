// Turning agent isolation on copies the agents' existing state into agent
// space once (design 4.10): each runtime home (Hermes memory and skills, Codex
// sessions) and each team folder. Not Clawboo Native's homes, and no sign-in
// or key file (`auth.json`, `.env`): before isolation those were copies of the
// operator's own logins and saved keys. The originals stay where they are, so turning
// the setting off again is the rollback.
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
}

export interface CopyInReport {
  copied: string[]
  /** Already there: the copy happened on an earlier start. */
  present: string[]
  skipped: { path: string; reason: string }[]
}

const STAGING = '.clawboo-copying'

/** Files never carried into agent space (see `copyTree`). */
const NEVER_COPIED = new Set(['auth.json', '.env'])

/** Every copy to make: runtime homes and team folders, by their folder names. */
export function planCopyIn(opts: {
  dataDir: string
  agentRuntimesRoot: string
  workDir: string
  /** Team folders' previous parents: `<data>/workspaces`, the old work folder's `teams/`. */
  teamRoots: string[]
}): CopyInItem[] {
  const items: CopyInItem[] = []
  const realDirs = (dir: string): string[] => {
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
    if (rt === 'native') continue
    for (const agent of realDirs(path.join(runtimes, rt))) {
      items.push({
        from: path.join(runtimes, rt, agent),
        to: path.join(opts.agentRuntimesRoot, rt, agent),
      })
    }
  }
  const seen = new Set<string>()
  for (const root of opts.teamRoots) {
    for (const team of realDirs(root)) {
      if (seen.has(team)) continue
      seen.add(team)
      items.push({ from: path.join(root, team), to: path.join(opts.workDir, 'teams', team) })
    }
  }
  return items
}

/** Copy each item that is not in agent space yet. Never throws for one item. */
export async function copyIntoAgentSpace(items: CopyInItem[]): Promise<CopyInReport> {
  const report: CopyInReport = { copied: [], present: [], skipped: [] }
  for (const item of items) {
    try {
      if (await agentStat(item.to)) {
        report.present.push(item.to)
        continue
      }
      const staging = `${item.to}${STAGING}`
      await agentRemove(staging)
      await agentMkdir(path.dirname(item.to))
      await copyTree(item.from, staging, report)
      await agentRename(staging, item.to)
      report.copied.push(item.to)
    } catch (err) {
      report.skipped.push({
        path: item.from,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return report
}

async function copyTree(src: string, dst: string, report: CopyInReport): Promise<void> {
  const st = fs.lstatSync(src)
  if (!st.isDirectory()) throw new Error(`${src} is not a folder`)
  await agentMkdir(dst, { mode: 0o700 })
  for (const name of fs.readdirSync(src).sort()) {
    const from = path.join(src, name)
    const to = path.join(dst, name)
    let e: fs.Stats
    try {
      e = fs.lstatSync(from)
    } catch {
      continue
    }
    if (e.isDirectory()) {
      await copyTree(from, to, report)
    } else if (e.isFile()) {
      // Sign-ins and keys the server put in a home before isolation came from
      // the operator's own logins and vault; the agent user gets its own.
      // Runs write the files they need again.
      if (NEVER_COPIED.has(name)) {
        report.skipped.push({ path: from, reason: 'a sign-in or key file, written again per run' })
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
