// The work folder (`resolveWorkDir`): where the newer layout keeps task
// worktrees and review checkouts, outside Clawboo's data folder. Nothing here
// creates it, and new checkouts still go under the data folder. The server's
// readers of those checkouts accept both places, so a version that keeps them
// in the work folder can be rolled back to this one without stranding a task.

import { realpathSync } from 'node:fs'
import path from 'node:path'

import { resolveWorkDir } from '@clawboo/config'

/**
 * The work folder through the links in its path, then as configured when that
 * differs; just as configured when it does not exist. A checkout recorded under
 * it may use either spelling, so a check against the folder accepts both. The
 * real path comes first because that is the one the newer layout records, so a
 * sweep that takes the first spelling names folders the way their records do.
 */
export function workDirSpellings(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = path.resolve(resolveWorkDir(env))
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {
    /* not there: nothing can be recorded under its real path either */
  }
  return real === dir ? [dir] : [real, dir]
}
