// The files a team's agents made lately, for Home: the newest files at the top of
// the task folders (`<team folder>/tasks/<task id>`) of the team's most recently
// changed tasks. Read through the same resolver the board's folder routes use, so
// agent isolation (folders the server cannot see itself) is respected, and a file
// opens with `GET /api/board/:taskId/folder/file?path=`.
//
// Best effort and bounded: a folder that is gone or unreadable is skipped, and a
// Home read never waits on more than a few folders.

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

/** How many of the newest tasks are looked at, and how many files come back. */
const TASKS_LOOKED_AT = 8
const FILES_RETURNED = 8
const ENTRIES_PER_FOLDER = 40

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
      for (const entry of listing.entries) {
        if (entry.kind !== 'file') continue
        const stat = await agentStat(path.join(root.root, entry.name))
        if (!stat || stat.type !== 'file') continue
        found.push({
          taskId: task.id,
          taskIdentifier: task.identifier ?? null,
          taskTitle: task.title,
          path: entry.name,
          sizeBytes: stat.size,
          modifiedAt: Math.round(stat.mtimeMs),
        })
      }
    } catch {
      // One unreadable folder never fails Home.
    }
  }
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, FILES_RETURNED)
}
