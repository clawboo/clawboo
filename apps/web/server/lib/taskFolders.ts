// Cleanup of task folders, `<team folder>/tasks/<task id>` (see
// runtimes/teamWorkdir.ts), on the rules task worktrees keep:
//
// - A task that can still run (To do, Blocked, In progress, In review, not
//   dropped) is never touched, and its status is read again right before each
//   removal, as the worktree sweep does.
// - Only this install's folders: the folder's name must be a task in this
//   install's database. A work folder can be shared by two installs, and task
//   ids are random, so a name this database does not know is someone else's.
// - Work is never lost. A worktree's sweep commits to the task's branch before it
//   drops the checkout; a task folder has no branch to keep its files, so only an
//   EMPTY folder of a finished task (Done, Cancelled, or dropped) goes, the way a
//   worktree with no changes is cleaned up when its task completes. A folder with
//   files stays until its team is deleted, which removes the team folder with
//   everything in it.
//
// Removal is a plain `rmdir`: it fails on a folder that holds anything, and on a
// link, so a file an agent writes while the sweep runs keeps the folder, and a
// link named for a task is never followed. Only `tasks/` itself is checked for
// being a link; a team folder that is a link is followed, which at worst removes
// an empty folder named for one of this install's finished tasks.
//
// With agents on their own OS user (CLAWBOO_AGENT_USER) the folders are that
// user's, and the server neither sees into them nor removes anything there as
// itself: every look, listing and removal goes to the agent host, which runs
// as the agent user (see agentUser/agentFs.ts). The rules above are the same.

import path from 'node:path'

import { getTask, teams, type ClawbooDb, type DbTask } from '@clawboo/db'
import { assertSafeTaskId } from '@clawboo/worktrees'

import { agentList, agentRemoveEmptyDir, agentStat } from './agentUser/agentFs'
import type { FsEntry } from './agentUser/protocol'
import { NO_TEAM_SEGMENT, TASK_FOLDERS_SEGMENT, teamWorkdirPath } from './runtimes/teamWorkdir'

/**
 * Remove a task folder if it is empty. The one place a task folder is removed.
 * Through the agent host with agent isolation on, a plain `rmdir` with it off
 * (`agentRemoveEmptyDir` is either). True when it went.
 */
export async function removeEmptyTaskFolder(dir: string): Promise<boolean> {
  try {
    await agentRemoveEmptyDir(dir)
    return true
  } catch {
    // Not empty, a link, already gone, or not allowed: kept.
    return false
  }
}

/** Finished for good unless a person reopens it: nothing will run in its folder. */
function finished(task: DbTask | null): boolean {
  if (!task) return false
  return Boolean(task.dropped) || task.status === 'done' || task.status === 'cancelled'
}

export interface TaskFolderGcResult {
  removed: string[]
  /** Folders of finished tasks that hold files, so stay. */
  kept: number
}

/**
 * Sweep the task folders of this install's teams (and the shared `_no-team`
 * folder): remove each empty one whose task is finished. Never throws for one
 * folder; a folder it cannot read is left.
 */
export async function gcTaskFolders(db: ClawbooDb): Promise<TaskFolderGcResult> {
  const result: TaskFolderGcResult = { removed: [], kept: 0 }
  const teamIds = [
    NO_TEAM_SEGMENT,
    ...db
      .select({ id: teams.id })
      .from(teams)
      .all()
      .map((t) => t.id),
  ]
  for (const teamId of teamIds) {
    let tasksDir: string
    try {
      tasksDir = path.join(teamWorkdirPath(teamId), TASK_FOLDERS_SEGMENT)
      // A link here would carry the sweep into some other folder. `agentStat`
      // never follows a link at the path's end, so one reads as `link`.
      if ((await agentStat(tasksDir))?.type !== 'dir') continue
    } catch {
      continue // no task folders yet
    }
    let entries: FsEntry[]
    try {
      // Every name: a capped listing would leave the rest of a big folder.
      entries = (await agentList(tasksDir, { max: 100_000 })).entries
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.type !== 'dir') continue // files, links, anything else: left
      let taskId: string
      try {
        taskId = assertSafeTaskId(entry.name)
      } catch {
        continue
      }
      // Read live, right before the removal: a task reopened while the sweep ran
      // keeps its folder.
      if (!finished(getTask(db, taskId))) continue
      const dir = path.join(tasksDir, taskId)
      if (await removeEmptyTaskFolder(dir)) result.removed.push(dir)
      else result.kept++
    }
  }
  return result
}
