// Files from the team's latest work, for Home: the files at the top of the task
// folders (`<team folder>/tasks/<task id>`) of the team's most recently changed
// tasks, the most recently modified first. Read through the same resolver the
// board's folder routes use, so agent isolation (folders the server cannot see
// itself) is respected, and a file opens with `GET /api/board/:taskId/folder/file?path=`.
//
// Not a search for the newest file anywhere: each folder's listing is cut by name
// (folders first) before any file is statted, so a folder with more entries than
// are read can hold a newer file than the ones shown. Finding it would mean
// statting every entry of every folder on each Home read.
//
// Best effort and bounded: a folder that is gone or unreadable is skipped, and a
// Home read looks at a few folders one after another, statting each one's files
// together.

import path from 'node:path'

import { listTasks, type ClawbooDb } from '@clawboo/db'

import { agentStat } from '../agentUser/agentFs'
import { listDirAt, resolveTaskFolderRoot } from '../workspaceFs'

export interface RecentTeamFile {
  taskId: string
  taskIdentifier: string | null
  taskTitle: string
  path: string
  sizeBytes: number
  modifiedAt: number
}

/** How many of the most recently changed tasks are looked at, how many entries of
 *  each one's folder are read (in name order), and how many files come back. */
const TASKS_LOOKED_AT = 8
const ENTRIES_PER_FOLDER = 40
const FILES_RETURNED = 8

export async function recentTeamFiles(db: ClawbooDb, teamId: string): Promise<RecentTeamFile[]> {
  const candidates = listTasks(db, { teamId })
    .filter((t) => t.isMainTask !== 1)
    .slice(0, TASKS_LOOKED_AT)
  const found: RecentTeamFile[] = []
  for (const task of candidates) {
    try {
      const root = await resolveTaskFolderRoot(task.id)
      if (!root.ok) continue
      const listing = await listDirAt(root.root, '', {
        exactRoot: true,
        maxEntries: ENTRIES_PER_FOLDER,
      })
      const files = listing.entries.filter((e) => e.kind === 'file')
      const stats = await Promise.all(
        files.map((entry) => agentStat(path.join(root.root, entry.name))),
      )
      files.forEach((entry, i) => {
        const stat = stats[i]
        if (!stat || stat.type !== 'file') return
        found.push({
          taskId: task.id,
          taskIdentifier: task.identifier ?? null,
          taskTitle: task.title,
          path: entry.name,
          sizeBytes: stat.size,
          modifiedAt: Math.round(stat.mtimeMs),
        })
      })
    } catch {
      // One unreadable folder never fails Home.
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, FILES_RETURNED)
}
